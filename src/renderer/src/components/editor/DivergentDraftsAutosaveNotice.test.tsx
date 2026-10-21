// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { DivergentDraftsAutosaveNotice } from './DivergentDraftsAutosaveNotice'
import { getDefaultSettings } from '../../../../shared/constants'

function tab(id: string, worktreeId: string): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    isDirty: true,
    mode: 'edit'
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home'), editorAutoSave: true },
    worktreesByRepo: {
      'repo-1': ['wt-1', 'wt-2'].map((id) =>
        makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId: 'local' })
      )
    },
    openFiles: [tab('a', 'wt-1'), tab('b', 'wt-2')]
  })
})

afterEach(cleanup)

it('explains the pause while the two tabs hold different text', () => {
  useAppStore.setState({ editorDrafts: { a: 'one', b: 'two' } })
  const { container } = render(<DivergentDraftsAutosaveNotice fileId="a" />)
  expect(container.textContent).toContain('Autosave is paused')
})

it('renders nothing once the drafts agree', () => {
  useAppStore.setState({ editorDrafts: { a: 'same', b: 'same' } })
  const { container } = render(<DivergentDraftsAutosaveNotice fileId="a" />)
  expect(container.textContent).toBe('')
})
