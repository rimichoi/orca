import { describe, expect, it } from 'vitest'
import { readMachineWorkAtRisk } from './machine-work-at-risk'

const meta = { runtimeId: 'r' }
const ok = (result: unknown) => ({ id: 'x', ok: true as const, result, _meta: meta })
const failed = {
  id: 'x',
  ok: false as const,
  error: { code: 'runtime_unavailable', message: 'down' },
  _meta: meta
}

describe('readMachineWorkAtRisk', () => {
  it('sums uncommitted entries and commits ahead across live worktrees on the server', async () => {
    const calls: string[] = []
    const work = await readMachineWorkAtRisk(async (method, params) => {
      calls.push(method)
      if (method === 'worktree.ps') {
        return ok({
          worktrees: [
            { worktreeId: 'w1' },
            { worktreeId: 'w2' },
            { worktreeId: 'w3', isArchived: true }
          ]
        })
      }
      const worktree =
        typeof params === 'object' && params !== null && 'worktree' in params
          ? params.worktree
          : null
      return ok(
        worktree === 'id:w1'
          ? { entries: [{}, {}], upstreamStatus: { ahead: 3 } }
          : { entries: [], didHitLimit: true, statusLength: 400, upstreamStatus: { ahead: 0 } }
      )
    })
    expect(work).toEqual({ uncommitted: 402, unpushed: 3 })
    expect(calls).toEqual(['worktree.ps', 'git.status', 'git.status'])
  })

  it('answers unknown when the list or any status cannot be read', async () => {
    expect(await readMachineWorkAtRisk(async () => failed)).toBeNull()
    expect(
      await readMachineWorkAtRisk(async (method) =>
        method === 'worktree.ps' ? ok({ worktrees: [{ worktreeId: 'w1' }] }) : failed
      )
    ).toBeNull()
    expect(
      await readMachineWorkAtRisk(async () => {
        throw new Error('tunnel closed')
      })
    ).toBeNull()
  })
})
