/**
 * The desktop's orchestration history for a committed WSL move (D1b-7e; owner decision 4: rewrite
 * in place, the desktop keeps coordinating). A settled local worker dispatch in a moved project,
 * and its worker-terminal row, take the host's worktree id. Everything else in orchestration.db
 * stays as written; `SQLITE_TABLE_DISPOSITIONS` gives each table's reason.
 */
import { existsSync } from 'node:fs'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import { hardenOrchestrationDatabaseFiles } from '../../runtime/orchestration/db/database-file-permissions'
import Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'
import { wslMoveRewriteScope, type WslMoveRewriteScope } from './wsl-move-rewrite-scope'

export const WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID = 'orchestration-history'

// The recoverable worker states; the move's gate refuses them, so a row still in one is left alone.
const LIVE_WORKER_STATES_SQL = `('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')`

type Rewrite = { key: string; from: string; to: string }

function text(row: SqliteRow, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' ? value : null
}

function hasColumns(db: Database, table: string, columns: readonly string[]): boolean {
  const names = new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => text(row, 'name'))
  )
  return columns.every((column) => names.has(column))
}

function hostWorktreeId(scope: WslMoveRewriteScope, worktreeId: string): string {
  return scope.inScope(worktreeId) ? scope.worktreeId(worktreeId) : worktreeId
}

/** Rows to rewrite; a structured (chat) worker stays local with its chat (owner decision C). */
function plan(
  rows: SqliteRow[],
  scope: WslMoveRewriteScope,
  keyColumn: string,
  handleColumn: string
): Rewrite[] {
  return rows.flatMap((row) => {
    const key = text(row, keyColumn)
    const from = text(row, 'worktree_id')
    if (!key || !from || isStructuredWorkerHandle(text(row, handleColumn))) {
      return []
    }
    const to = hostWorktreeId(scope, from)
    return to === from ? [] : [{ key, from, to }]
  })
}

function dispatchRewrites(db: Database, scope: WslMoveRewriteScope): Rewrite[] {
  if (
    !hasColumns(db, 'worker_dispatches', [
      'dispatch_id',
      'worktree_id',
      'state',
      'agent_terminal_handle'
    ])
  ) {
    return []
  }
  const rows = db
    .prepare(
      `SELECT dispatch_id, worktree_id, agent_terminal_handle FROM worker_dispatches
        WHERE worktree_id IS NOT NULL AND state NOT IN ${LIVE_WORKER_STATES_SQL}`
    )
    .all()
  return plan(rows, scope, 'dispatch_id', 'agent_terminal_handle')
}

function resourceRewrites(db: Database, scope: WslMoveRewriteScope): Rewrite[] {
  if (
    !hasColumns(db, 'worker_terminal_resources', [
      'id',
      'worktree_id',
      'owner_dispatch_id',
      'terminal_handle'
    ]) ||
    !hasColumns(db, 'worker_dispatches', ['dispatch_id', 'state'])
  ) {
    return []
  }
  // A federated worker's row belongs with its attachment, which a remote home reads verbatim.
  const remote = hasColumns(db, 'remote_dispatch_attachments', ['dispatch_id'])
    ? `AND r.owner_dispatch_id NOT IN (SELECT dispatch_id FROM remote_dispatch_attachments)`
    : ''
  const rows = db
    .prepare(
      `SELECT r.id, r.worktree_id, r.terminal_handle FROM worker_terminal_resources r
         LEFT JOIN worker_dispatches w ON w.dispatch_id = r.owner_dispatch_id
        WHERE r.worktree_id IS NOT NULL
          AND (w.state IS NULL OR w.state NOT IN ${LIVE_WORKER_STATES_SQL})
          ${remote}`
    )
    .all()
  return plan(rows, scope, 'id', 'terminal_handle')
}

// updated_at is left alone: the rewrite must not reorder history.
function applyRewrites(db: Database, sql: string, rewrites: readonly Rewrite[]): number {
  if (rewrites.length === 0) {
    return 0
  }
  const update = db.prepare(sql)
  return rewrites.reduce(
    (changed, row) => changed + Number(update.run(row.to, row.key, row.from).changes),
    0
  )
}

/**
 * Idempotent: a rewritten id is no longer a UNC path of the distro, so a second run finds nothing.
 * One write transaction for both tables. Returns how many rows changed.
 */
export function rewriteWslMoveOrchestrationHistory(
  db: Database,
  scope: WslMoveRewriteScope
): number {
  db.exec('BEGIN IMMEDIATE')
  try {
    const changed =
      applyRewrites(
        db,
        `UPDATE worker_dispatches SET worktree_id = ? WHERE dispatch_id = ? AND worktree_id = ?`,
        dispatchRewrites(db, scope)
      ) +
      applyRewrites(
        db,
        `UPDATE worker_terminal_resources SET worktree_id = ? WHERE id = ? AND worktree_id = ?`,
        resourceRewrites(db, scope)
      )
    db.exec('COMMIT')
    return changed
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Its own connection, so it runs before the runtime opens the database at startup. It never creates
 * the file or migrates it: a profile with no database has no history, and an older schema is read
 * as it stands.
 */
export function registerWslMoveOrchestrationHistoryStore(databasePath: string): void {
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_ORCHESTRATION_HISTORY_STORE_ID,
    side: 'main',
    run: (context) => {
      if (!existsSync(databasePath)) {
        return
      }
      const db = new Database(databasePath, { fileMustExist: true, timeout: 5_000 })
      try {
        // A FULL commit is on disk when it returns, which is what the ledger entry needs.
        db.pragma('synchronous = FULL')
        rewriteWslMoveOrchestrationHistory(db, wslMoveRewriteScope(context))
      } finally {
        db.close()
        hardenOrchestrationDatabaseFiles(databasePath)
      }
    },
    // `run` commits with synchronous FULL, so its write is durable before this is called.
    flush: () => {}
  })
}
