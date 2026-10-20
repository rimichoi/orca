import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../shared/structured-worker-handle'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import { orchestrationDbFile } from '../../runtime/orchestration/db/orchestration-db-file'
import Database from '../../sqlite/sync-database'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers, wslMoveJournalDirectory } from './wsl-move-cutover-journal'
import { runWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import {
  listWslMoveDesktopRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests
} from './wsl-move-desktop-rewrite-stores'
import {
  registerWslMoveOrchestrationHistoryStore,
  rewriteWslMoveOrchestrationHistory,
  WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID
} from './wsl-move-orchestration-history-rewrite'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'

const MOVED = 'repo-a::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-a'
const MOVED_ON_HOST = 'repo-a::/home/dev/repo-a'
const STAYING = 'repo-b::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-b'
const OTHER_DISTRO = 'repo-a::\\\\wsl.localhost\\Debian\\home\\dev\\repo-a'
const SSH_PATH = 'repo-a::/srv/repo-a'
const CHAT_HANDLE = `${STRUCTURED_WORKER_HANDLE_PREFIX}chat-1`

let userDataPath: string
let databasePath: string

function committedMove(rewrittenStores: string[] = []) {
  return wslMoveCutoverFixture(
    'move-1',
    'destination-committed',
    { rewrittenStores },
    { repoIds: ['repo-a'] }
  )
}

function withDb<T>(operate: (db: Database) => T): T {
  const db = new Database(databasePath, { fileMustExist: true })
  try {
    return operate(db)
  } finally {
    db.close()
  }
}

/** The current schema, through the real constructor, then rows as a desktop would hold them. */
function seedOrchestrationHistory(): void {
  new OrchestrationDb(databasePath).close()
  withDb((db) => {
    const dispatch = db.prepare(
      `INSERT INTO worker_dispatches (dispatch_id, state, worktree_id, agent_terminal_handle)
       VALUES (?, ?, ?, ?)`
    )
    dispatch.run('d-moved', 'succeeded', MOVED, 'term_1')
    dispatch.run('d-failed', 'failed', MOVED, 'term_2')
    dispatch.run('d-live', 'ready', MOVED, 'term_3')
    dispatch.run('d-chat', 'succeeded', MOVED, CHAT_HANDLE)
    dispatch.run('d-staying', 'succeeded', STAYING, 'term_4')
    dispatch.run('d-other-distro', 'succeeded', OTHER_DISTRO, 'term_5')
    dispatch.run('d-ssh', 'succeeded', SSH_PATH, 'term_6')
    dispatch.run('d-no-worktree', 'abandoned', null, null)
    const resource = db.prepare(
      `INSERT INTO worker_terminal_resources
         (id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle)
       VALUES (?, ?, ?, ?, ?)`
    )
    resource.run('r-moved', 'd-moved', 'd-moved', MOVED, 'term_1')
    resource.run('r-live', 'd-live', 'd-live', MOVED, 'term_3')
    resource.run('r-chat', 'd-chat', 'd-chat', MOVED, CHAT_HANDLE)
    resource.run('r-remote', 'd-remote', 'd-remote', MOVED, 'term_7')
    db.prepare(
      `INSERT INTO remote_dispatch_attachments
         (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state, worktree_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('d-remote', 'task-1', 'peer', 'epoch', 'succeeded', MOVED)
  })
}

function worktreeIds(table: string, key: string): Record<string, string | null> {
  return withDb((db) =>
    Object.fromEntries(
      db
        .prepare(`SELECT ${key} AS key, worktree_id FROM ${table} ORDER BY ${key}`)
        .all()
        .map((row) => [
          String(row.key),
          typeof row.worktree_id === 'string' ? row.worktree_id : null
        ])
    )
  )
}

const dispatchIds = () => worktreeIds('worker_dispatches', 'dispatch_id')
const resourceIds = () => worktreeIds('worker_terminal_resources', 'id')
const attachmentIds = () => worktreeIds('remote_dispatch_attachments', 'dispatch_id')

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-orchestration-'))
  databasePath = orchestrationDbFile(userDataPath)
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  registerWslMoveOrchestrationHistoryStore(databasePath)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('WSL move orchestration history rewrite', () => {
  it('registers one main-side store', () => {
    expect(listWslMoveDesktopRewriteStores().map((store) => [store.id, store.side])).toEqual([
      [WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID, 'main']
    ])
  })

  it("gives a moved project's settled local dispatches the host's worktree id", async () => {
    seedOrchestrationHistory()
    seedWslMoveCutover(userDataPath, committedMove())

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([
      WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID
    ])
    expect(dispatchIds()).toEqual({
      'd-chat': MOVED,
      'd-failed': MOVED_ON_HOST,
      'd-live': MOVED,
      'd-moved': MOVED_ON_HOST,
      'd-no-worktree': null,
      'd-other-distro': OTHER_DISTRO,
      'd-ssh': SSH_PATH,
      'd-staying': STAYING
    })
    expect(resourceIds()).toEqual({
      'r-chat': MOVED,
      'r-live': MOVED,
      'r-moved': MOVED_ON_HOST,
      'r-remote': MOVED
    })
    expect(attachmentIds()).toEqual({ 'd-remote': MOVED })
  })

  it('leaves timestamps and JSON receipts as written', async () => {
    seedOrchestrationHistory()
    const before = withDb((db) =>
      db.prepare(`SELECT updated_at, effects, start_options FROM worker_dispatches`).all()
    )
    seedWslMoveCutover(userDataPath, committedMove())

    await runWslMoveDesktopRewritePass({ userDataPath })

    const after = withDb((db) =>
      db.prepare(`SELECT updated_at, effects, start_options FROM worker_dispatches`).all()
    )
    expect(after).toEqual(before)
  })

  it('changes nothing when a crash lost its ledger entry and it runs again', async () => {
    seedOrchestrationHistory()
    seedWslMoveCutover(userDataPath, committedMove())
    await runWslMoveDesktopRewritePass({ userDataPath })
    const dispatches = dispatchIds()
    const resources = resourceIds()
    rmSync(wslMoveJournalDirectory(userDataPath), { recursive: true, force: true })
    seedWslMoveCutover(userDataPath, committedMove())

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([
      WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID
    ])
    expect(dispatchIds()).toEqual(dispatches)
    expect(resourceIds()).toEqual(resources)
    const scope = wslMoveRewriteScope({
      cutover: committedMove(),
      rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
      destinationHostId: 'runtime:wsl:Ubuntu',
      recordSeededHostWorkspaceIds: () => {}
    })
    expect(withDb((db) => rewriteWslMoveOrchestrationHistory(db, scope))).toBe(0)
  })

  it('touches nothing with no move journal', async () => {
    seedOrchestrationHistory()
    const bytes = readFileSync(databasePath)
    const dispatches = dispatchIds()

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(readFileSync(databasePath).equals(bytes)).toBe(true)
    expect(dispatchIds()).toEqual(dispatches)
  })

  it('touches nothing for a move that has not committed', async () => {
    seedOrchestrationHistory()
    const dispatches = dispatchIds()
    seedWslMoveCutover(userDataPath, { ...committedMove(), phase: 'blobs-transferred' })

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(dispatchIds()).toEqual(dispatches)
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
  })

  it('records the store without creating a database the profile never had', async () => {
    seedWslMoveCutover(userDataPath, committedMove())

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(existsSync(databasePath)).toBe(false)
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([
      WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID
    ])
  })

  it('reads an older schema as it stands', async () => {
    const db = new Database(databasePath)
    db.exec(`CREATE TABLE worker_dispatches (dispatch_id TEXT PRIMARY KEY, state TEXT NOT NULL)`)
    db.close()
    seedWslMoveCutover(userDataPath, committedMove())

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([
      WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID
    ])
  })
})
