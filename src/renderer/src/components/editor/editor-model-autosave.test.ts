// Why: tabs of one file in two workspaces share one text model, so autosave runs once per model,
// writes its newest text, and never lets an older sibling draft land over a newer write.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

const PATH = '/repo/a.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(worktreeIds: string[]) {
  const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [PATH]: 'disk' }))
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': worktreeIds.map((id) =>
        makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId: 'local' })
      )
    }
  })
  const ids = worktreeIds.map((worktreeId) =>
    store.getState().openFile({
      filePath: PATH,
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
  const cleanup = attachEditorAutosaveController(store)
  const written = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => String(args.content))
  const tab = (id: string) => store.getState().openFiles.find((file) => file.id === id)
  return { disk, store, ids, edit, cleanup, written, tab }
}

describe('autosave per text model', () => {
  it('a single tab still autosaves normally', async () => {
    const { ids, edit, cleanup, written, tab } = setup(['wt-1'])
    try {
      edit(ids[0], 'one')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(written()).toEqual(['one'])
      expect(tab(ids[0])?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('two workspaces holding the same text share one timer: one write, both clean', async () => {
    const { ids, edit, cleanup, written, tab } = setup(['wt-1', 'wt-2'])
    expect(new Set(ids).size).toBe(2)
    try {
      edit(ids[0], 'shared')
      edit(ids[1], 'shared')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(written()).toEqual(['shared'])
      expect(ids.map((id) => tab(id)?.isDirty)).toEqual([false, false])
    } finally {
      cleanup()
    }
  })

  it('autosave writes the newest edit; the older sibling draft never lands', async () => {
    const { disk, ids, edit, cleanup, written, tab } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[0], 'from A')
      await vi.advanceTimersByTimeAsync(500)
      edit(ids[1], 'from B')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(written()).toEqual(['from B'])
      expect(disk.files.get(PATH)).toBe('from B')
      expect(tab(ids[0])?.externalMutation).toBe('changed')
    } finally {
      cleanup()
    }
  })

  it('a manual save of the newer tab is never followed by the older tab autosaving', async () => {
    const { disk, ids, edit, cleanup, written } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[0], 'from A')
      edit(ids[1], 'chosen B')
      await requestEditorFileSave({ fileId: ids[1] })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(written()).toEqual(['chosen B'])
      expect(disk.files.get(PATH)).toBe('chosen B')
    } finally {
      cleanup()
    }
  })

  it('a manual save of an older tab leaves the newer sibling edit to autosave', async () => {
    const { disk, ids, edit, cleanup, written, tab } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[1], 'older B')
      edit(ids[0], 'newer A')
      await requestEditorFileSave({ fileId: ids[1] })
      expect(tab(ids[0])?.externalMutation).toBeUndefined()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(written()).toEqual(['older B', 'newer A'])
      expect(disk.files.get(PATH)).toBe('newer A')
    } finally {
      cleanup()
    }
  })

  it("another tab's quiesce does not cancel a user save", async () => {
    const { ids, edit, cleanup, written } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[1], 'saved by hand')
      const save = requestEditorFileSave({ fileId: ids[1] })
      const quiesce = requestEditorSaveQuiesce({ fileId: ids[0] })
      await expect(save).resolves.toBeUndefined()
      await quiesce
      expect(written()).toEqual(['saved by hand'])
    } finally {
      cleanup()
    }
  })
})
