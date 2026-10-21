import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import { editorModelRegistry } from '@/lib/editor-model-registry'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  isAutosaveSuspendedForFile,
  type EditorPathMutationTarget
} from './editor-autosave'
import {
  editorModelSiblingTabs,
  editorTabModelUri,
  isCodeViewTab
} from './editor-save-disk-precondition'
import { toEditorModelUri } from './editor-model-uri'
import { resolveEditorModelOwner, resolvedEditorModelOwnerKey } from './editor-model-owner'

/** Edit tabs of one file and host share their model's save queue and any discard hold. */
export function editorSaveKeyOfFile(state: AppState, file: OpenFile): string {
  return file.mode === 'edit' ? editorTabModelUri(state, file) : file.id
}

/**
 * Code-view tabs show the live model text, so they share one autosave timer and generation. Rich,
 * CSV and notebook views hold their own text and keep their own, as each tab did before.
 */
export function editorScheduleKeyOfFile(state: AppState, file: OpenFile): string {
  return isCodeViewTab(state, file) ? editorTabModelUri(state, file) : file.id
}

/** The model text every code-view tab of `file` shows; undefined before any of them mounted. */
export function readLiveModelText(state: AppState, file: OpenFile): string | undefined {
  const registry = editorModelRegistry.get()
  return registry?.editor.getModel(registry.Uri.parse(editorTabModelUri(state, file)))?.getValue()
}

/**
 * What an autosave of a shared code-view model writes: its live text. Before any tab mounted there
 * is no live text, so only drafts every dirty tab agrees on; divergent ones write nothing.
 */
export function sharedModelAutosaveText(state: AppState, file: OpenFile): string | undefined {
  const live = readLiveModelText(state, file)
  if (live !== undefined) {
    return live
  }
  const drafts = new Set(
    editorModelSiblingTabs(state, file).flatMap((tab) => {
      const draft = state.editorDrafts[tab.id]
      return tab.isDirty && draft !== undefined ? [draft] : []
    })
  )
  return drafts.size === 1 ? [...drafts][0] : undefined
}

/**
 * Whether another code-view tab shares `file`'s model. Its stored draft may be a stale snapshot
 * (it updates only while mounted), so only the live model text is safe to autosave.
 */
export function sharesCodeViewModel(state: AppState, file: OpenFile): boolean {
  if (!isCodeViewTab(state, file)) {
    return false
  }
  // Why filter on path first: resolving a model URI walks the worktree route.
  const others = state.openFiles.filter(
    (tab) => tab.id !== file.id && tab.filePath === file.filePath && isCodeViewTab(state, tab)
  )
  if (others.length === 0) {
    return false
  }
  const key = editorTabModelUri(state, file)
  return others.some((tab) => editorTabModelUri(state, tab) === key)
}

function holdsAutosaveDraft(state: AppState, file: OpenFile): boolean {
  return file.isDirty && state.editorDrafts[file.id] !== undefined && canAutoSaveOpenFile(file)
}

/** `drafts` only detects edits (a new one restarts the debounce); a shared model saves live text. */
export type PlannedAutoSave = { fileId: string; drafts: readonly string[]; liveModel: boolean }

/** At most one autosave per timer key; a suspended or paused tab pauses its whole key. */
export function planAutoSaves(
  state: AppState,
  isPaused: (file: OpenFile) => boolean
): Map<string, PlannedAutoSave> {
  const holdersByKey = new Map<string, OpenFile[]>()
  for (const file of state.openFiles.filter((tab) => holdsAutosaveDraft(state, tab))) {
    const key = editorScheduleKeyOfFile(state, file)
    holdersByKey.set(key, [...(holdersByKey.get(key) ?? []), file])
  }
  const plans = new Map<string, PlannedAutoSave>()
  for (const [key, holders] of holdersByKey) {
    if (holders.some((file) => isAutosaveSuspendedForFile(file) || isPaused(file))) {
      continue
    }
    plans.set(key, {
      fileId: holders[0].id,
      drafts: holders.map((file) => state.editorDrafts[file.id] ?? ''),
      liveModel: sharesCodeViewModel(state, holders[0])
    })
  }
  return plans
}

export function samePlannedAutoSave(a: PlannedAutoSave | undefined, b: PlannedAutoSave): boolean {
  return (
    a !== undefined &&
    a.fileId === b.fileId &&
    a.liveModel === b.liveModel &&
    a.drafts.length === b.drafts.length &&
    a.drafts.every((draft, index) => draft === b.drafts[index])
  )
}

/**
 * Save keys a path mutation (git discard) touches: the matched tabs' models, plus the model the
 * path maps to in the target workspace, which another workspace's tab may hold with none open here.
 */
export function pathMutationSaveKeys(
  state: AppState,
  target: EditorPathMutationTarget
): Set<string> {
  const keys = new Set(
    getOpenFilesForExternalFileChange(state.openFiles, target).map((file) =>
      editorSaveKeyOfFile(state, file)
    )
  )
  const ownerKey = resolvedEditorModelOwnerKey(
    resolveEditorModelOwner(
      {
        worktreeId: target.worktreeId,
        ...(Object.hasOwn(target, 'runtimeEnvironmentId')
          ? { runtimeEnvironmentId: target.runtimeEnvironmentId }
          : {})
      },
      state
    )
  )
  // Why: an unresolved owner keys its model per tab, so no other tab can share it.
  if (ownerKey !== null) {
    keys.add(toEditorModelUri(joinPath(target.worktreePath, target.relativePath), ownerKey))
  }
  return keys
}
