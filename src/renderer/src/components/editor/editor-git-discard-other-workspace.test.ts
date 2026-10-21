// Why: a Source Control discard in one workspace must stop autosave of the same file in every
// workspace showing it, until git has rewritten the file and the change notice marked the tabs.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notifyEditorExternalFileChange, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const DISCARD_TARGET = { worktreeId: 'wt-1', worktreePath: '/repo', relativePath: 'a.ts' }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(openIn: string[]) {
  const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ '/repo/a.ts': 'saved change' }))
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
  const ids = openIn.map((worktreeId) =>
    store.getState().openFile({
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  )
  withLoadedBaselines(store, disk)
  const edit = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  for (const id of ids) {
    edit(id, 'unsaved edit')
  }
  const cleanup = attachEditorAutosaveController(store)
  const writes = (): number => disk.fs.writeFile.mock.calls.length
  return { disk, store, ids, edit, cleanup, writes }
}

it('git discard in one workspace pauses the same file autosave in another', async () => {
  const { disk, ids, edit, cleanup, writes } = setup(['wt-1', 'wt-2'])
  expect(new Set(ids).size).toBe(2)
  try {
    await requestEditorSaveQuiesce(DISCARD_TARGET)
    // Typing in wt-2 while git runs must not start a new autosave of the file.
    edit(ids[1], 'unsaved edit, more')
    disk.files.set('/repo/a.ts', 'HEAD')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
  } finally {
    cleanup()
  }
})

it('pauses another workspace even when the discarding workspace has no tab of the file', async () => {
  const { disk, cleanup, writes } = setup(['wt-2'])
  try {
    await requestEditorSaveQuiesce(DISCARD_TARGET)
    disk.files.set('/repo/a.ts', 'HEAD')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
  } finally {
    cleanup()
  }
})

it('after the change notice the dirty tabs show the banner and still write nothing', async () => {
  const { disk, store, ids, cleanup, writes } = setup(['wt-1', 'wt-2'])
  try {
    await requestEditorSaveQuiesce(DISCARD_TARGET)
    disk.files.set('/repo/a.ts', 'HEAD')
    notifyEditorExternalFileChange(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    const tabs = store.getState().openFiles.filter((file) => ids.includes(file.id))
    expect(tabs.map((file) => file.externalMutation)).toEqual(['changed', 'changed'])
    expect(tabs.map((file) => store.getState().editorDrafts[file.id])).toEqual([
      'unsaved edit',
      'unsaved edit'
    ])
  } finally {
    cleanup()
  }
})

it('a discard that never reports back stops pausing autosave after the safety timeout', async () => {
  const { disk, cleanup, writes } = setup(['wt-1', 'wt-2'])
  try {
    await requestEditorSaveQuiesce(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(writes()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(writes()).toBeGreaterThan(0)
    expect(disk.files.get('/repo/a.ts')).toBe('unsaved edit')
  } finally {
    cleanup()
  }
})
