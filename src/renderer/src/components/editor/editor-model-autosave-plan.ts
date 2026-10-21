import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  isAutosaveSuspendedForFile,
  type EditorPathMutationTarget
} from './editor-autosave'
import { editorTabModelUri } from './editor-save-disk-precondition'

/** Edit tabs share their model's save queue, timer and generation; any other tab keeps its own. */
export function editorSaveKeyOfFile(state: AppState, file: OpenFile): string {
  return file.mode === 'edit' ? editorTabModelUri(state, file) : file.id
}

/** A tab whose unsaved draft an autosave of its model would write. */
function holdsAutosaveDraft(state: AppState, file: OpenFile): boolean {
  return file.isDirty && state.editorDrafts[file.id] !== undefined && canAutoSaveOpenFile(file)
}

export type PlannedAutoSave = { fileId: string; draft: string }

/**
 * At most one autosave per model. Tabs of one model holding different unsaved text pause it, so
 * neither workspace's draft silently replaces the other's; a manual save still writes.
 */
export function planModelAutoSaves(
  state: AppState,
  heldKeys: ReadonlySet<string>
): Map<string, PlannedAutoSave> {
  const holdersByKey = new Map<string, OpenFile[]>()
  for (const file of state.openFiles.filter((tab) => holdsAutosaveDraft(state, tab))) {
    const key = editorSaveKeyOfFile(state, file)
    holdersByKey.set(key, [...(holdersByKey.get(key) ?? []), file])
  }
  const plans = new Map<string, PlannedAutoSave>()
  for (const [key, holders] of holdersByKey) {
    const draft = state.editorDrafts[holders[0].id]
    if (
      draft === undefined ||
      heldKeys.has(key) ||
      // Why: suspension holds until the user picks a side via the banner (or saves manually).
      holders.some(isAutosaveSuspendedForFile) ||
      holders.some((file) => state.editorDrafts[file.id] !== draft)
    ) {
      continue
    }
    plans.set(key, { fileId: holders[0].id, draft })
  }
  return plans
}

/** Whether another tab of `file`'s model holds unsaved text different from `content`. */
export function hasDivergentModelDraft(state: AppState, file: OpenFile, content: string): boolean {
  if (file.mode !== 'edit') {
    return false
  }
  // Why filter on path first: resolving a model URI walks the worktree route.
  const candidates = state.openFiles.filter(
    (tab) =>
      tab.id !== file.id &&
      tab.filePath === file.filePath &&
      holdsAutosaveDraft(state, tab) &&
      state.editorDrafts[tab.id] !== content
  )
  if (candidates.length === 0) {
    return false
  }
  const key = editorSaveKeyOfFile(state, file)
  return candidates.some((tab) => editorSaveKeyOfFile(state, tab) === key)
}

/** A dirty tab whose autosave is paused because another tab of its model holds different text. */
export function isModelAutosavePausedByDivergentDrafts(state: AppState, fileId: string): boolean {
  // Why first: the store selector runs on every update, so bail before any scan when autosave is off.
  if (state.settings?.editorAutoSave !== true) {
    return false
  }
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  const draft = state.editorDrafts[fileId]
  return (
    file !== undefined &&
    draft !== undefined &&
    holdsAutosaveDraft(state, file) &&
    hasDivergentModelDraft(state, file, draft)
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
  const targetFile: OpenFile = {
    id: '',
    filePath: joinPath(target.worktreePath, target.relativePath),
    relativePath: target.relativePath,
    worktreeId: target.worktreeId,
    language: '',
    isDirty: false,
    mode: 'edit',
    ...(Object.hasOwn(target, 'runtimeEnvironmentId')
      ? { runtimeEnvironmentId: target.runtimeEnvironmentId }
      : {})
  }
  keys.add(editorSaveKeyOfFile(state, targetFile))
  return keys
}
