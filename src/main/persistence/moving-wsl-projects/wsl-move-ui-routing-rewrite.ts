/**
 * The persisted UI's routing to a moved project, rewritten to the WSL host after a move commits:
 * worktree-keyed preferences take the host's ids, and every host filter that shows `local` also
 * shows the host. Nothing is removed, so the retained local entry keeps its own preferences, and a
 * second run finds nothing left to change.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { getRepoHostIdentityForParts } from '../../../shared/repo-host-identity'
import type {
  ManualRepoOrderEntry,
  VisibleWorkspaceHostIds,
  WorkspaceHostOrder
} from '../../../shared/ui-chrome-types'
import type { WorkspaceCleanupDismissal } from '../../../shared/workspace-cleanup'
import { getWorkspaceCleanupHostIdentity } from '../../../shared/workspace-cleanup-host-identity'
import { resolveVisibleWorkspaceHostIds } from '../../../shared/workspace-view/workspace-host-visibility'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { WslMoveRewriteScope } from './wsl-move-rewrite-scope'

export type WslMoveUiRoutingState = Pick<
  PersistedUIState,
  | 'lastActiveWorktreeId'
  | 'showDotfilesByWorktree'
  | 'explorerDisplayRootByWorktree'
  | 'workspaceCleanup'
  | 'manualRepoOrder'
  | 'workspaceHostScope'
  | 'visibleWorkspaceHostIds'
  | 'agentsVisibleHostIds'
  | 'workspaceHostOrder'
  | 'setupScriptPromptDismissedRepoIds'
  | 'collapsedGroups'
>

// Mirrors the renderer's keys (setup-script-prompt.ts, group-keys.ts); main cannot import them.
const SETUP_SCRIPT_DISMISSAL_PREFIX = 'generation-v1:'
const LINEAGE_GROUP_PREFIX = 'lineage:'
const CLEANUP_IDENTITY_SEPARATOR = '\0'

/** Only the fields that change; empty when the UI already routes to the host. */
export function rewriteWslMoveUiRouting(
  ui: WslMoveUiRoutingState,
  scope: WslMoveRewriteScope
): Partial<WslMoveUiRoutingState> {
  const updates: Partial<WslMoveUiRoutingState> = {}
  const lastActive = ui.lastActiveWorktreeId
  if (lastActive && scope.inScope(lastActive) && scope.worktreeId(lastActive) !== lastActive) {
    updates.lastActiveWorktreeId = scope.worktreeId(lastActive)
  }
  const hostWorktreeKey = (key: string): string =>
    scope.inScope(key) ? scope.worktreeId(key) : key
  const dotfiles = rekey(ui.showDotfilesByWorktree, hostWorktreeKey, (value) => value)
  if (dotfiles) {
    updates.showDotfilesByWorktree = dotfiles
  }
  const roots = rekey(ui.explorerDisplayRootByWorktree, hostWorktreeKey, scope.path)
  if (roots) {
    updates.explorerDisplayRootByWorktree = roots
  }
  const dismissals = rekey(
    ui.workspaceCleanup?.dismissals,
    (key) => hostDismissalKey(key, scope),
    (dismissal) => rewriteDismissal(dismissal, scope)
  )
  if (ui.workspaceCleanup && dismissals) {
    updates.workspaceCleanup = { ...ui.workspaceCleanup, dismissals }
  }
  const repoOrder = rewriteManualRepoOrder(ui.manualRepoOrder, scope)
  if (repoOrder) {
    updates.manualRepoOrder = repoOrder
  }
  // The legacy scalar scope stays: it is also the default host for new workspaces.
  const visible = withHostBesideLocal(
    resolveVisibleWorkspaceHostIds(ui.visibleWorkspaceHostIds, ui.workspaceHostScope),
    scope
  )
  if (visible) {
    updates.visibleWorkspaceHostIds = visible
  }
  const agentsVisible = withHostBesideLocal(ui.agentsVisibleHostIds, scope)
  if (agentsVisible) {
    updates.agentsVisibleHostIds = agentsVisible
  }
  const hostOrder = withHostBesideLocal(ui.workspaceHostOrder, scope)
  if (hostOrder) {
    updates.workspaceHostOrder = hostOrder
  }
  const setupDismissals = addHostSetupDismissals(ui.setupScriptPromptDismissedRepoIds, scope)
  if (setupDismissals) {
    updates.setupScriptPromptDismissedRepoIds = setupDismissals
  }
  const collapsed = addHostLineageGroups(ui.collapsedGroups, scope)
  if (collapsed) {
    updates.collapsedGroups = collapsed
  }
  return updates
}

/** Moved keys take the host's form; a key the host form already holds keeps that row. */
function rekey<T>(
  record: Record<string, T> | undefined,
  hostKeyOf: (key: string) => string,
  mapValue: (value: T) => T
): Record<string, T> | null {
  if (!record) {
    return null
  }
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const hostKey = hostKeyOf(key)
    if (hostKey === key) {
      if (!Object.hasOwn(next, key)) {
        next[key] = value
      }
      continue
    }
    changed = true
    if (!Object.hasOwn(record, hostKey)) {
      next[hostKey] = mapValue(value)
    }
  }
  return changed ? next : null
}

/** `<host>\0<worktreeId>` (workspace-cleanup-host-identity.ts) or a legacy bare worktree id. */
function hostDismissalKey(key: string, scope: WslMoveRewriteScope): string {
  const separator = key.indexOf(CLEANUP_IDENTITY_SEPARATOR)
  const worktreeId = separator === -1 ? key : key.slice(separator + 1)
  const host = separator === -1 ? null : key.slice(0, separator)
  if ((host !== null && host !== LOCAL_EXECUTION_HOST_ID) || !scope.inScope(worktreeId)) {
    return key
  }
  const hostWorktreeId = scope.worktreeId(worktreeId)
  if (hostWorktreeId === worktreeId) {
    return key
  }
  return host === null
    ? hostWorktreeId
    : getWorkspaceCleanupHostIdentity(scope.destinationHostId, hostWorktreeId)
}

function rewriteDismissal(
  dismissal: WorkspaceCleanupDismissal,
  scope: WslMoveRewriteScope
): WorkspaceCleanupDismissal {
  const host = dismissal.executionHostId
  return {
    ...dismissal,
    worktreeId: scope.worktreeId(dismissal.worktreeId),
    ...(host === LOCAL_EXECUTION_HOST_ID ? { executionHostId: scope.destinationHostId } : {})
  }
}

function rewriteManualRepoOrder(
  order: ManualRepoOrderEntry[] | undefined,
  scope: WslMoveRewriteScope
): ManualRepoOrderEntry[] | null {
  if (!order?.some((entry) => isMovedLocalRepo(entry, scope))) {
    return null
  }
  const onHost = new Set(
    order.filter((entry) => entry.hostId === scope.destinationHostId).map((entry) => entry.repoId)
  )
  return order.flatMap((entry) => {
    if (!isMovedLocalRepo(entry, scope)) {
      return [entry]
    }
    // The host already lists it: one row per repo and host, at the earlier position.
    if (onHost.has(entry.repoId)) {
      return []
    }
    onHost.add(entry.repoId)
    return [{ hostId: scope.destinationHostId, repoId: entry.repoId }]
  })
}

function isMovedLocalRepo(entry: ManualRepoOrderEntry, scope: WslMoveRewriteScope): boolean {
  return entry.hostId === LOCAL_EXECUTION_HOST_ID && scope.repoInScope(entry.repoId)
}

function withHostBesideLocal<T extends WorkspaceHostOrder | VisibleWorkspaceHostIds | undefined>(
  hostIds: T,
  scope: WslMoveRewriteScope
): WorkspaceHostOrder | null {
  if (
    !hostIds ||
    !hostIds.includes(LOCAL_EXECUTION_HOST_ID) ||
    hostIds.includes(scope.destinationHostId)
  ) {
    return null
  }
  return hostIds.flatMap((hostId) =>
    hostId === LOCAL_EXECUTION_HOST_ID ? [hostId, scope.destinationHostId] : [hostId]
  )
}

/** The host's form beside the local one: either survives the renderer's prune by the catalog. */
function addHostSetupDismissals(
  entries: string[] | undefined,
  scope: WslMoveRewriteScope
): string[] | null {
  if (!entries) {
    return null
  }
  const added: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(SETUP_SCRIPT_DISMISSAL_PREFIX)) {
      continue
    }
    const identity = entry.slice(SETUP_SCRIPT_DISMISSAL_PREFIX.length)
    const separator = identity.indexOf('\0')
    const host = separator === -1 ? LOCAL_EXECUTION_HOST_ID : identity.slice(0, separator)
    const repoId = identity.slice(separator + 1)
    if (host !== LOCAL_EXECUTION_HOST_ID || !scope.repoInScope(repoId)) {
      continue
    }
    const hostEntry = `${SETUP_SCRIPT_DISMISSAL_PREFIX}${getRepoHostIdentityForParts(repoId, scope.destinationHostId)}`
    if (!entries.includes(hostEntry) && !added.includes(hostEntry)) {
      added.push(hostEntry)
    }
  }
  return added.length > 0 ? [...entries, ...added] : null
}

/** A collapsed lineage group of a moved local worktree stays collapsed under the host. */
function addHostLineageGroups(
  groups: string[] | undefined,
  scope: WslMoveRewriteScope
): string[] | null {
  if (!groups) {
    return null
  }
  const added: string[] = []
  for (const key of groups) {
    if (!key.startsWith(LINEAGE_GROUP_PREFIX)) {
      continue
    }
    const identity = key.slice(LINEAGE_GROUP_PREFIX.length)
    const qualified = isWorktreeHostIdentity(identity)
    const host = qualified ? getExecutionHostIdFromWorktreeHostIdentity(identity) : undefined
    // An unqualified key may name the local row; nothing else on this desktop has a UNC id.
    if (qualified && host !== undefined && host !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const worktreeId = qualified ? getWorktreeIdFromHostIdentity(identity) : identity
    const hostWorktreeId = scope.worktreeId(worktreeId)
    if (!scope.inScope(worktreeId) || hostWorktreeId === worktreeId) {
      continue
    }
    const hostKey = `${LINEAGE_GROUP_PREFIX}${composeWorktreeHostIdentity(scope.destinationHostId, hostWorktreeId)}`
    if (!groups.includes(hostKey) && !added.includes(hostKey)) {
      added.push(hostKey)
    }
  }
  return added.length > 0 ? [...groups, ...added] : null
}
