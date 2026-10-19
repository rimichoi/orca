import { z } from 'zod'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

/** Uncommitted changes and unpushed commits on a machine; null when they could not be read. */
export type MachineWorkAtRisk = { uncommitted: number; unpushed: number }

type RuntimeCall = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

// Short: a warning about to fire must not wait out a slow host, and "couldn't check" is an answer.
const READ_TIMEOUT_MS = 5_000
const MAX_WORKTREES = 50

const worktreesSchema = z.object({
  worktrees: z.array(z.object({ worktreeId: z.string(), isArchived: z.boolean().optional() }))
})
const statusSchema = z.object({
  entries: z.array(z.unknown()),
  didHitLimit: z.boolean().optional(),
  statusLength: z.number().optional(),
  upstreamStatus: z.object({ ahead: z.number() }).optional()
})

function resultOf<T>(response: RuntimeRpcResponse<unknown>, schema: z.ZodType<T>): T | null {
  if (!response.ok) {
    return null
  }
  const parsed = schema.safeParse(response.result)
  return parsed.success ? parsed.data : null
}

/**
 * Reads every worktree on the machine's Orca server (where a machine's worktrees live) and sums
 * their uncommitted entries and commits ahead of upstream. Any read that fails makes the whole
 * answer null, so a warning never claims "nothing to lose" from partial evidence.
 */
export async function readMachineWorkAtRisk(call: RuntimeCall): Promise<MachineWorkAtRisk | null> {
  try {
    const listed = resultOf(
      await call(
        'worktree.ps',
        { limit: MAX_WORKTREES, supportsWorktreeVisibilitySourceDefaults: true },
        READ_TIMEOUT_MS
      ),
      worktreesSchema
    )
    if (!listed) {
      return null
    }
    const statuses = await Promise.all(
      listed.worktrees
        .filter((worktree) => !worktree.isArchived)
        .map(async (worktree) =>
          resultOf(
            await call(
              'git.status',
              {
                worktree: `id:${worktree.worktreeId}`,
                admissionTier: 'background',
                includeLineStats: false
              },
              READ_TIMEOUT_MS
            ),
            statusSchema
          )
        )
    )
    if (statuses.some((status) => status === null)) {
      return null
    }
    return statuses.reduce<MachineWorkAtRisk>(
      (total, status) => ({
        uncommitted:
          total.uncommitted +
          (status?.didHitLimit && status.statusLength
            ? status.statusLength
            : (status?.entries.length ?? 0)),
        unpushed: total.unpushed + (status?.upstreamStatus?.ahead ?? 0)
      }),
      { uncommitted: 0, unpushed: 0 }
    )
  } catch {
    return null
  }
}
