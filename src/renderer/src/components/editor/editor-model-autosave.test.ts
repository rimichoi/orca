// Why: code-view tabs of one file in two workspaces show one text model, so they share one autosave
// timer that writes the model's live text; a stale draft of an unmounted tab is never written.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  stubEditorWindowWithDisk,
  withLoadedBaselines
} from './editor-autosave-controller-test-fixture'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

// Live Monaco model text by model URI, as the editor-model registry would expose it.
const liveModels = vi.hoisted(() => new Map<string, string>())
vi.mock('@/lib/editor-model-registry', () => ({
  editorModelRegistry: {
    get: () => ({
      Uri: { parse: (uri: string) => uri },
      editor: {
        getModel: (uri: string) =>
          liveModels.has(uri) ? { getValue: () => liveModels.get(uri) } : null
      }
    })
  }
}))

beforeEach(() => {
  vi.useFakeTimers()
  liveModels.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(worktreeIds: string[], fileName = 'a.ts') {
  const path = `/repo/${fileName}`
  const disk = stubEditorWindowWithDisk(createFakeEditorDisk({ [path]: 'disk' }))
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
      filePath: path,
      relativePath: fileName,
      worktreeId,
      language: fileName.endsWith('.md') ? 'markdown' : 'typescript',
      mode: 'edit'
    })
  )
  withLoadedBaselines(store, disk)
  /** A stored draft only, e.g. one restored from a session or left by an unmounted tab. */
  const edit = (id: string, text: string): void => {
    store.getState().setEditorDraft(id, text)
    store.getState().markFileDirty(id, true)
  }
  /** Typing in a mounted code view: the shared model and that tab's draft change together. */
  const type = (id: string, text: string): void => {
    liveModels.set(`file://${path}`, text)
    edit(id, text)
  }
  const cleanup = attachEditorAutosaveController(store)
  const written = (): string[] => disk.fs.writeFile.mock.calls.map(([args]) => String(args.content))
  const tab = (id: string) => store.getState().openFiles.find((file) => file.id === id)
  return { path, disk, store, ids, edit, type, cleanup, written, tab }
}

describe('autosave per text model', () => {
  it('a single tab still autosaves its draft normally', async () => {
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

  it('typing in W1 then W2 writes the live text once; both clean, no banner', async () => {
    const { path, disk, store, ids, type, cleanup, written, tab } = setup(['wt-1', 'wt-2'])
    try {
      type(ids[0], 'abc')
      await vi.advanceTimersByTimeAsync(500)
      // W1 unmounts with its "abc" snapshot; W2 mounts the shared model and types.
      type(ids[1], 'abcd')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(written()).toEqual(['abcd'])
      expect(disk.files.get(path)).toBe('abcd')
      expect(ids.map((id) => tab(id)?.isDirty)).toEqual([false, false])
      expect(ids.map((id) => tab(id)?.externalMutation)).toEqual([undefined, undefined])
      // No stale "abc" draft is left to push back into the model when W1 remounts.
      expect(store.getState().editorDrafts[ids[0]]).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it('divergent drafts with no live model autosave nothing; a manual save writes only itself', async () => {
    const { ids, edit, cleanup, written, tab } = setup(['wt-1', 'wt-2'])
    try {
      edit(ids[0], 'restored A')
      edit(ids[1], 'restored B')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(written()).toEqual([])
      await requestEditorFileSave({ fileId: ids[0] })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(written()).toEqual(['restored A'])
      expect(tab(ids[1])?.isDirty).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("a rich tab's pending typing is never settled by a source tab's save", async () => {
    const { store, ids, edit, type, cleanup, tab } = setup(['wt-1', 'wt-2'], 'a.md')
    store.setState({ markdownViewMode: { [ids[0]]: 'source' } })
    // The rich tab's stored draft matches, but newer TipTap text waits on its 300 ms publish.
    const unregister = registerPendingEditorFlush(ids[1], () => {})
    try {
      edit(ids[1], 'same text')
      type(ids[0], 'same text')
      await requestEditorFileSave({ fileId: ids[0] })
      expect(tab(ids[0])?.isDirty).toBe(false)
      expect(tab(ids[1])?.isDirty).toBe(true)
    } finally {
      unregister()
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
