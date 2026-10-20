/**
 * What a move into a distro's host takes (mover design, sections 4.3 and 5): the first move takes
 * the selected projects; every later one is a delta move, a new journal record chained by
 * `supersedesMigrationId`, that takes only projects no earlier move of the distro took. One move
 * per distro is in flight at a time.
 *
 * A project an earlier move took and an older build has since changed is listed, not taken: the
 * host already holds it under the same ids and refuses a second copy, so the change stays in the
 * retained row (as SSH's delta does; see `planOrcadDeltaMove`).
 */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { isOrcadMigrationLocalWslSource } from '../../../shared/orcad-migration/orcad-migration-source-kind'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import {
  WSL_MOVE_CUTOVER_VERSION,
  isWslMoveCutoverFinished,
  wslMoveJournalKey,
  type WslMoveCutover
} from '../../../shared/wsl-move/wsl-move-cutover'
import { listWslMoveCutoverChain, writeWslMoveCutover } from './wsl-move-cutover-journal'
import {
  wslMoveLocalRowIdentity,
  wslMoveRowKey,
  wslMoveScopeRefs,
  wslMoveTakenRowIdentity,
  type WslMoveRowRef
} from './wsl-move-retained-source'
import { collectWslMoveScope, type WslMoveScope } from './wsl-move-scope'
import { isLocalWslMoveRow } from './wsl-move-scope-guard'

type WslMovePlanState = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
}

export type WslMovePlanRefusal =
  /** Another move of this distro has not finished; it resumes or resets first. */
  | 'wsl_move_already_in_flight'
  /** Every selected project is already on the host, unchanged or not. */
  | 'wsl_move_nothing_new'

export type WslMovePlan = {
  distro: string
  journalKey: string
  /** The finished move this one extends; absent for the distro's first move. */
  supersedesMigrationId?: string
  /** A delta goes to the host the chain already uses. */
  destinationEnvironmentId?: string
  generation: number
  repoIds: string[]
  folderWorkspaceIds: string[]
  /** Taken earlier, then changed by an older build: listed for the user, not moved again. */
  changed: WslMoveRowRef[]
  /** Taken earlier, and no longer in this profile; the host keeps its copy. */
  removed: WslMoveRowRef[]
  refused: WslMoveScope['refused']
}

export type WslMovePlanResult =
  | { outcome: 'ready'; plan: WslMovePlan }
  | { outcome: 'refused'; code: WslMovePlanRefusal }

/** Throws only when the distro's journal cannot be read. */
export function planWslMove(
  userDataPath: string,
  state: WslMovePlanState,
  distro: string,
  /** The projects the user ticked; absent means the whole distro. */
  selection?: { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] }
): WslMovePlanResult {
  const journalKey = wslMoveJournalKey(distro)
  const chain = listWslMoveCutoverChain(userDataPath, journalKey)
  const head = chain.at(-1)
  if (head && !isWslMoveCutoverFinished(head)) {
    return { outcome: 'refused', code: 'wsl_move_already_in_flight' }
  }
  // Newest move per row: what the host holds for it now.
  const taken = new Map<string, { ref: WslMoveRowRef; owner: Readonly<WslMoveCutover> }>()
  for (const cutover of chain) {
    for (const ref of wslMoveScopeRefs(cutover)) {
      taken.set(wslMoveRowKey(ref), { ref, owner: cutover })
    }
  }
  const scope = collectWslMoveScope(state, distro)
  const selected = (ref: WslMoveRowRef): boolean =>
    !selection ||
    (ref.kind === 'repo' ? selection.repoIds : selection.folderWorkspaceIds).includes(ref.id)
  // Local rows only: the host's own row carries the same id.
  const rows = new Map<string, Repo | FolderWorkspace>()
  for (const repo of state.repos) {
    if (isLocalWslMoveRow(repo) && scope.repoIds.includes(repo.id)) {
      rows.set(wslMoveRowKey({ kind: 'repo', id: repo.id }), repo)
    }
  }
  for (const folder of state.folderWorkspaces) {
    if (isLocalWslMoveRow(folder) && scope.folderWorkspaceIds.includes(folder.id)) {
      rows.set(wslMoveRowKey({ kind: 'folder', id: folder.id }), folder)
    }
  }
  const candidates: WslMoveRowRef[] = [
    ...scope.repoIds.map((id) => ({ kind: 'repo' as const, id })),
    ...scope.folderWorkspaceIds.map((id) => ({ kind: 'folder' as const, id }))
  ]
  const fresh: WslMoveRowRef[] = []
  const changed: WslMoveRowRef[] = []
  for (const ref of candidates) {
    const owner = taken.get(wslMoveRowKey(ref))?.owner
    const row = rows.get(wslMoveRowKey(ref))
    if (!owner) {
      if (selected(ref)) {
        fresh.push(ref)
      }
    } else if (
      row &&
      wslMoveTakenRowIdentity(owner, ref) !== wslMoveLocalRowIdentity(row, distro)
    ) {
      changed.push(ref)
    }
  }
  const removed = [...taken.entries()]
    .filter(([key]) => !rows.has(key))
    .map(([, entry]) => entry.ref)
  if (fresh.length === 0) {
    return { outcome: 'refused', code: 'wsl_move_nothing_new' }
  }
  return {
    outcome: 'ready',
    plan: {
      distro,
      journalKey,
      ...(head
        ? {
            supersedesMigrationId: head.migrationId,
            destinationEnvironmentId: head.destinationEnvironmentId
          }
        : {}),
      generation: (head?.manifest.source.generation ?? 0) + 1,
      repoIds: fresh.filter((ref) => ref.kind === 'repo').map((ref) => ref.id),
      folderWorkspaceIds: fresh.filter((ref) => ref.kind === 'folder').map((ref) => ref.id),
      changed,
      removed,
      refused: scope.refused
    }
  }
}

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && new Set([...left, ...right]).size === left.length

/**
 * Journals a planned move at `prepared`. The manifest must be exactly the plan's scope, and the
 * journal refuses it if another move of the distro journaled or finished since the plan was made.
 */
export function journalWslMove(args: {
  userDataPath: string
  plan: WslMovePlan
  manifest: OrcadMigrationManifest
  destinationName: string
  now?: () => Date
}): WslMoveCutover {
  const { plan, manifest } = args
  const { source, destinationEnvironmentId } = manifest
  if (
    !destinationEnvironmentId ||
    !isOrcadMigrationLocalWslSource(source) ||
    wslMoveJournalKey(source.distro) !== plan.journalKey ||
    source.generation !== plan.generation ||
    !sameIds(source.scopeRepoIds, plan.repoIds) ||
    !sameIds(source.scopeFolderWorkspaceIds, plan.folderWorkspaceIds) ||
    (plan.destinationEnvironmentId !== undefined &&
      destinationEnvironmentId !== plan.destinationEnvironmentId)
  ) {
    throw new Error('wsl_move_manifest_not_planned')
  }
  const timestamp = (args.now ?? (() => new Date()))().toISOString()
  const cutover: WslMoveCutover = {
    version: WSL_MOVE_CUTOVER_VERSION,
    migrationId: manifest.migrationId,
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId,
    destinationName: args.destinationName,
    journalKey: plan.journalKey,
    manifestSha256: manifest.manifestSha256,
    provenExitedSessionIds: [],
    rewrittenStores: [],
    ...(plan.supersedesMigrationId ? { supersedesMigrationId: plan.supersedesMigrationId } : {}),
    manifest: { ...manifest, source }
  }
  // The journal re-checks under its own read: one in-flight move, extending the current head.
  writeWslMoveCutover(args.userDataPath, cutover)
  return cutover
}
