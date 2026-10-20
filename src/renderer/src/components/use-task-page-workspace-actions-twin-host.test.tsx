// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageSearchActionsModel } from './use-task-page-search-actions'
import { useTaskPageWorkspaceActions } from './use-task-page-workspace-actions'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: vi.fn() }) }
}))

const sshRow: Repo = {
  id: 'twin',
  path: '/remote/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  connectionId: 'builder'
}
const localRow: Repo = { ...sshRow, path: '/laptop/twin', addedAt: 2, connectionId: undefined }
const pr: GitHubWorkItem = {
  id: 'pr-7',
  type: 'pr',
  number: 7,
  title: 'Fix it',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octo',
  repoId: 'twin',
  repoHostId: 'ssh:builder'
}

describe('starting work from a PR card on a repo id two hosts share', () => {
  it('opens the composer for the host that returned the PR', () => {
    const openModal = vi.fn()
    const repos = [sshRow, localRow]
    // By id a map keeps the last twin, which is the row that did not return the PR.
    const model = { repos, repoMap: new Map(repos.map((repo) => [repo.id, repo])), openModal }
    const { result } = renderHook(() =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields.
      useTaskPageWorkspaceActions(model as unknown as TaskPageSearchActionsModel)
    )

    result.current.handleUseWorkItem(pr)

    expect(openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        taskSourceContext: expect.objectContaining({ hostId: 'ssh:builder', repoId: 'twin' })
      })
    )
  })
})
