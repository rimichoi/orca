/**
 * The saved session after a WSL move commits: the desktop's focus follows a moved workspace to the
 * host, and the host's partition starts from the session the move carried, so the first paint
 * shows the moved tabs before the host publishes. Native chats stay on this computer (owner
 * decision, option C), and terminals restart on the host, so neither is seeded.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import {
  mergeWorkspaceSessionArrayField,
  mergeWorkspaceSessionRecordField
} from '../../../shared/workspace-session-host-records'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  filterWorkspaceRows,
  workspaceIdsNamedByPartition
} from '../../../shared/workspace-session-stranded-partition-adoption'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { WslMoveRewriteScope } from './wsl-move-rewrite-scope'

type SessionGlobals = Pick<
  WorkspaceSessionState,
  'activeWorktreeId' | 'activeWorkspaceKey' | 'activeWorkspaceExecutionHostId'
>

/** The local partition's focus on the host when it points into the move; null when it does not. */
export function wslMoveSessionGlobalsPatch(
  session: SessionGlobals,
  scope: WslMoveRewriteScope
): WorkspaceSessionPatch | null {
  const host = session.activeWorkspaceExecutionHostId
  // Focus already on a host (the WSL one included) names that host's ids, not the moved local ones.
  if (host && host !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const worktreeId = session.activeWorktreeId
  const key = session.activeWorkspaceKey
  const movedWorktree = worktreeId ? scope.inScope(worktreeId) : false
  const movedKey = key ? scope.inScope(key) : false
  if (!movedWorktree && !movedKey) {
    return null
  }
  const parsedKey = key && movedKey ? parseWorkspaceKey(key) : null
  return {
    activeWorkspaceExecutionHostId: scope.destinationHostId,
    ...(worktreeId && movedWorktree ? { activeWorktreeId: scope.worktreeId(worktreeId) } : {}),
    ...(parsedKey?.type === 'worktree'
      ? {
          activeWorkspaceKey: worktreeWorkspaceKey(scope.worktreeId(parsedKey.worktreeId))
        }
      : {})
  }
}

// Restart hints for local PTYs; the host decides what to start for its own terminals.
const UNSEEDED_FIELDS: ReadonlySet<string> = new Set(['activeWorktreeIdsOnShutdown'])

/**
 * `existing` plus the carried rows of every moved workspace it names nothing for, or null when
 * there is none: what the host already published is never replaced.
 */
export function wslMoveHostSessionSeed(
  carried: WorkspaceSessionState,
  existing: WorkspaceSessionState,
  scope: WslMoveRewriteScope
): WorkspaceSessionState | null {
  const published = workspaceIdsNamedByPartition(existing)
  const stripped = withoutChatTabs(withoutPtyBindings(carried))
  const seeded = new Set(
    [...workspaceIdsNamedByPartition(stripped)].filter(
      (workspaceId) => scope.inScope(workspaceId) && !published.has(workspaceId)
    )
  )
  if (seeded.size === 0) {
    return null
  }
  const rows = filterWorkspaceRows(stripped, (workspaceId) => seeded.has(workspaceId))
  const next = structuredClone(existing)
  for (const [field, ownership] of Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)) {
    if (
      !isSessionField(field) ||
      ownership === 'global' ||
      ownership === 'hostPrivate' ||
      UNSEEDED_FIELDS.has(field)
    ) {
      continue
    }
    if (ownership === 'worktreeArray') {
      mergeWorkspaceSessionArrayField(next, field, rows)
    } else {
      mergeWorkspaceSessionRecordField(next, field, rows)
    }
  }
  return next
}

function isSessionField(field: string): field is keyof WorkspaceSessionState {
  return Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field)
}

/** Every local PTY binding (item 36): the host starts its own terminals. */
function withoutPtyBindings(session: WorkspaceSessionState): WorkspaceSessionState {
  const {
    remoteSessionIdsByTabId: _remoteSessions,
    terminalPtyIncarnationsByPaneKey: _incarnations,
    ...rest
  } = session
  return {
    ...rest,
    tabsByWorktree: Object.fromEntries(
      Object.entries(session.tabsByWorktree).map(([owner, tabs]) => [
        owner,
        tabs.map((tab) => ({ ...tab, ptyId: null }))
      ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).map(([tabId, layout]) => {
        const { ptyIdsByLeafId: _ptyIds, ...unbound } = layout
        return [tabId, unbound]
      })
    )
  }
}

function isChatTab(tab: Pick<Tab, 'contentType'>): boolean {
  return tab.contentType === 'agent-session'
}

/** Chat tabs, and the focus and groups that name them; they stay listed on the local entry. */
function withoutChatTabs(session: WorkspaceSessionState): WorkspaceSessionState {
  const chatIds = new Set(
    Object.values(session.unifiedTabs ?? {}).flatMap((tabs) =>
      tabs.filter(isChatTab).map((tab) => tab.id)
    )
  )
  if (chatIds.size === 0) {
    return session
  }
  const unifiedTabs = Object.fromEntries(
    Object.entries(session.unifiedTabs ?? {}).map(([owner, tabs]) => [
      owner,
      tabs.filter((tab) => !isChatTab(tab))
    ])
  )
  const tabGroups = Object.fromEntries(
    Object.entries(session.tabGroups ?? {}).map(([owner, groups]) => [
      owner,
      groups.map((group) => withoutTabs(group, chatIds))
    ])
  )
  const notChat = (value: string | null | undefined): boolean => !value || !chatIds.has(value)
  return {
    ...session,
    unifiedTabs,
    tabGroups,
    activeTabIdByWorktree: pickValues(session.activeTabIdByWorktree, notChat),
    activeTabTypeByWorktree: pickValues(
      session.activeTabTypeByWorktree,
      (type) => type !== 'agent-session'
    ),
    sleepingAgentSessionsByPaneKey: pickValues(session.sleepingAgentSessionsByPaneKey, (record) =>
      notChat(record.tabId)
    )
  }
}

function withoutTabs(group: TabGroup, tabIds: ReadonlySet<string>): TabGroup {
  const tabOrder = group.tabOrder.filter((id) => !tabIds.has(id))
  const recentTabIds = group.recentTabIds?.filter((id) => !tabIds.has(id))
  const activeTabId =
    group.activeTabId && !tabIds.has(group.activeTabId)
      ? group.activeTabId
      : (recentTabIds?.at(-1) ?? tabOrder.at(-1) ?? null)
  return {
    ...group,
    tabOrder,
    activeTabId,
    ...(recentTabIds ? { recentTabIds } : {})
  }
}

function pickValues<T>(
  record: Record<string, T> | undefined,
  keep: (value: T) => boolean
): Record<string, T> | undefined {
  return record && Object.fromEntries(Object.entries(record).filter(([, value]) => keep(value)))
}
