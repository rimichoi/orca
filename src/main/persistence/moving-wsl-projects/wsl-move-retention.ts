/**
 * Retain and reconcile for WSL moves (mover design, section 4.5), extending what
 * `reconcileManagedOrcadSshTargets` does for SSH hosts:
 * - Retain: a move whose desktop rewrite finished (`client-rewritten`) marks its source rows, makes
 *   the marks durable, and only then becomes `retained`. Nothing is deleted.
 * - Reconcile, on start and after every journal change: put back marks an older build stripped,
 *   flag rows whose identity it changed (a later move offers them; none runs on its own), and drop
 *   marks no committed move explains, such as after "Use on this computer again".
 */
import { resolve } from 'node:path'
import { wslHostsGateOpen } from '../../wsl/wsl-host-gate'
import type { Store } from '../loading-store/store'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  onWslMoveJournalChange,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import { planWslMoveRetainedMarks, type WslMoveRowRef } from './wsl-move-retained-source'

export type WslMoveRetentionStore = Pick<
  Store,
  'getRepos' | 'getFolderWorkspaces' | 'setWslMoveRetainedMarks' | 'flushPendingOrThrowAsync'
>

export type WslMoveRetentionOptions = {
  userDataPath: string
  store: WslMoveRetentionStore
  now?: () => Date
  warn?: (message: string) => void
}

export type WslMoveRetentionReport = {
  /** Moves this pass advanced to `retained`. */
  retainedMigrationIds: string[]
  /** Rows whose mark this pass wrote or removed. */
  rewrittenMarks: number
  /** Retained rows an older build changed; a later move of the distro can take the changes. */
  changed: WslMoveRowRef[]
}

async function runPass(options: WslMoveRetentionOptions): Promise<WslMoveRetentionReport | null> {
  const { userDataPath, store } = options
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const now = (options.now ?? (() => new Date()))().toISOString()
  let chains: ReturnType<typeof listWslMoveCutoverChain>[]
  try {
    const keys = new Set(listWslMoveCutovers(userDataPath).map((cutover) => cutover.journalKey))
    chains = [...keys].map((key) => listWslMoveCutoverChain(userDataPath, key))
  } catch (error) {
    // Unreadable: no mark is added or removed, since none can be explained.
    warn(
      `[wsl-move] Could not read the move journal to reconcile retained rows: ${describe(error)}`
    )
    return null
  }
  const retaining = new Set(
    chains
      .flat()
      .flatMap((cutover) => (cutover.phase === 'client-rewritten' ? [cutover.migrationId] : []))
  )
  const plan = planWslMoveRetainedMarks({
    chains,
    retaining,
    repos: store.getRepos(),
    folderWorkspaces: store.getFolderWorkspaces(),
    now
  })
  const rewrittenMarks = store.setWslMoveRetainedMarks(plan.marks)
  if (rewrittenMarks > 0) {
    await store.flushPendingOrThrowAsync()
  }
  const retainedMigrationIds: string[] = []
  for (const migrationId of retaining) {
    // Fresh from disk: "Use on this computer again" may have dropped it while the marks flushed.
    const current = listWslMoveCutovers(userDataPath).find(
      (cutover) => cutover.migrationId === migrationId
    )
    if (current?.phase !== 'client-rewritten') {
      continue
    }
    writeWslMoveCutover(userDataPath, { ...current, phase: 'retained', updatedAt: now })
    retainedMigrationIds.push(migrationId)
  }
  return { retainedMigrationIds, rewrittenMarks, changed: plan.changed }
}

let passQueue: Promise<unknown> = Promise.resolve()

/** Never throws; serialized, and a no-op with the internal WSL hosts gate closed. */
export function runWslMoveRetentionPass(
  options: WslMoveRetentionOptions
): Promise<WslMoveRetentionReport | null> {
  if (!wslHostsGateOpen()) {
    return Promise.resolve(null)
  }
  const next = passQueue.then(() =>
    runPass(options).catch((error: unknown) => {
      // Marks are idempotent and a move becomes `retained` only after its marks are durable.
      ;(options.warn ?? console.warn)(
        `[wsl-move] Retaining moved projects paused: ${describe(error)}`
      )
      return null
    })
  )
  passQueue = next
  return next
}

/** Startup: one pass now, then one after each journal change (coalesced). Returns the stop. */
export function installWslMoveRetention(options: WslMoveRetentionOptions): () => void {
  let queued = false
  const schedule = (): void => {
    if (queued) {
      return
    }
    queued = true
    void passQueue.then(() => {
      queued = false
      return runWslMoveRetentionPass(options)
    })
  }
  schedule()
  return onWslMoveJournalChange((changedPath) => {
    if (resolve(changedPath) === resolve(options.userDataPath)) {
      schedule()
    }
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
