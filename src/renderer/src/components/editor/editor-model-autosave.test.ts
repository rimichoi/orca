// Why: tabs of one file in two workspaces share one text model, so autosave runs once per model and
// pauses, rather than letting the last writer win, while the tabs hold different unsaved text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'
import { isModelAutosavePausedByDivergentDrafts } from './editor-model-autosave-plan'
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
  const paused = (id: string): boolean =>
    isModelAutosavePausedByDivergentDrafts(store.getState(), id)
  return { disk, store, ids, edit, cleanup, written, paused }
}

describe('autosave per text model', () => {
  it('a single tab still autosaves normally', async () => {
    const { store, ids, edit, cleanup, written, paused } = setup(['wt-1'])
    try {
      edit(ids[0], 'one')
      expect(paused(ids[0])).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(written()).toEqual(['one'])
      expect(store.getState().openFiles[0].isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('two workspaces holding the same text share one timer: one write per debounce', async () => {
    const { ids, edit, cleanup, written } = setup(['wt-1', 'wt-2'])
    expect(new Set(ids).size).toBe(2)
    try {
      edit(ids[0], 'shared')
      edit(ids[1], 'shared')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(written()).toEqual(['shared'])
    } finally {
      cleanup()
    }
  })

  it('divergent drafts pause autosave until they converge', async () => {
    const { ids, edit, cleanup, written, paused } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[0], 'from wt-1')
      edit(ids[1], 'from wt-2')
      expect(paused(ids[0])).toBe(true)
      expect(paused(ids[1])).toBe(true)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(written()).toEqual([])

      edit(ids[0], 'from wt-2')
      expect(paused(ids[0])).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(written()).toEqual(['from wt-2'])
    } finally {
      cleanup()
    }
  })

  it('cancels an armed autosave the moment a second workspace diverges', async () => {
    const { ids, edit, cleanup, written } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[0], 'from wt-1')
      await vi.advanceTimersByTimeAsync(500)
      edit(ids[1], 'from wt-2')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(written()).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('a manual save still writes the tab it was asked for while drafts diverge', async () => {
    const { ids, edit, cleanup, written } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[0], 'from wt-1')
      edit(ids[1], 'from wt-2')
      await requestEditorFileSave({ fileId: ids[1] })
      expect(written()).toEqual(['from wt-2'])
    } finally {
      cleanup()
    }
  })

  it('is not paused when autosave is off', () => {
    const { store, ids, edit, cleanup, paused } = setup(['wt-1', 'wt-2'])
    try {
      const settings = store.getState().settings
      expect(settings).toBeTruthy()
      if (settings) {
        store.setState({ settings: { ...settings, editorAutoSave: false } })
      }
      edit(ids[0], 'from wt-1')
      edit(ids[1], 'from wt-2')
      expect(paused(ids[0])).toBe(false)
    } finally {
      cleanup()
    }
  })
})
