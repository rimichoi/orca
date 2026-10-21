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

/** The discard flow: quiesce, git restores the file after `gitMs`, notify, release the hold. */
async function discard(
  disk: { files: Map<string, string> },
  options: { gitMs: number; fails?: true }
): Promise<void> {
  const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
  await vi.advanceTimersByTimeAsync(options.gitMs)
  if (!options.fails) {
    disk.files.set('/repo/a.ts', 'HEAD')
    notifyEditorExternalFileChange(DISCARD_TARGET)
  }
  release()
}

it('git discard in one workspace pauses the same file autosave in another', async () => {
  const { disk, store, ids, edit, cleanup, writes } = setup(['wt-1', 'wt-2'])
  expect(new Set(ids).size).toBe(2)
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    // Typing in wt-2 while git runs must not start a new autosave of the file.
    edit(ids[1], 'unsaved edit, more')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    disk.files.set('/repo/a.ts', 'HEAD')
    notifyEditorExternalFileChange(DISCARD_TARGET)
    release()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
    // The dirty tabs keep their edits behind the changed-on-disk banner.
    const tabs = store.getState().openFiles
    expect(tabs.map((file) => file.externalMutation)).toEqual(['changed', 'changed'])
    expect(store.getState().editorDrafts[ids[1]]).toBe('unsaved edit, more')
  } finally {
    cleanup()
  }
})

it('pauses another workspace even when the discarding workspace has no tab of the file', async () => {
  const { disk, store, cleanup, writes } = setup(['wt-2'])
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    disk.files.set('/repo/a.ts', 'HEAD')
    release()
    // Afterwards the guarded write refuses the stale save and raises the banner.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
    expect(store.getState().openFiles[0].externalMutation).toBe('changed')
  } finally {
    cleanup()
  }
})

it('a slow git restore writes nothing until it finishes', async () => {
  const { disk, cleanup, writes } = setup(['wt-1', 'wt-2'])
  try {
    await discard(disk, { gitMs: 30_000 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    expect(disk.files.get('/repo/a.ts')).toBe('HEAD')
  } finally {
    cleanup()
  }
})

it('a watcher notice alone does not lift the hold before git finishes', async () => {
  const { store, ids, edit, cleanup, writes } = setup(['wt-2'])
  try {
    const release = await requestEditorSaveQuiesce(DISCARD_TARGET)
    notifyEditorExternalFileChange({ ...DISCARD_TARGET, worktreeId: 'wt-2' })
    store.getState().setExternalMutation(ids[0], null)
    edit(ids[0], 'typed after the notice')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes()).toBe(0)
    release()
  } finally {
    cleanup()
  }
})

it('a failed discard releases the hold at once, so autosave resumes', async () => {
  const { disk, cleanup, writes } = setup(['wt-1', 'wt-2'])
  try {
    await discard(disk, { gitMs: 100, fails: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes()).toBe(1)
    expect(disk.files.get('/repo/a.ts')).toBe('unsaved edit')
  } finally {
    cleanup()
  }
})

it('a hold never released fails closed after the backstop: banner, no write', async () => {
  const { disk, store, cleanup, writes } = setup(['wt-1', 'wt-2'])
  try {
    await requestEditorSaveQuiesce(DISCARD_TARGET)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(writes()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writes()).toBe(0)
    expect(store.getState().openFiles.map((file) => file.externalMutation)).toEqual([
      'changed',
      'changed'
    ])
    expect(disk.files.get('/repo/a.ts')).toBe('saved change')
  } finally {
    cleanup()
  }
})
