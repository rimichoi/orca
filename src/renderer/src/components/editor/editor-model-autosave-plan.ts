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
import { toEditorModelUri } from './editor-model-uri'
import { resolveEditorModelOwner, resolvedEditorModelOwnerKey } from './editor-model-owner'

/** Edit tabs share their model's save queue, timer and generation; any other tab keeps its own. */
export function editorSaveKeyOfFile(state: AppState, file: OpenFile): string {
  return file.mode === 'edit' ? editorTabModelUri(state, file) : file.id
}

/** A tab whose unsaved draft an autosave of its model could write. */
export function holdsAutosaveDraft(state: AppState, file: OpenFile): boolean {
  return file.isDirty && state.editorDrafts[file.id] !== undefined && canAutoSaveOpenFile(file)
}

export type PlannedAutoSave = { fileId: string; draft: string }

/**
 * At most one autosave per model, of its most recently edited tab's draft: the newest text, which
 * is what main's per-tab timers left on disk last. A suspended newest tab writes nothing.
 */
export function planModelAutoSaves(
  state: AppState,
  heldKeys: ReadonlySet<string>,
  editSeqOf: (fileId: string) => number
): Map<string, PlannedAutoSave> {
  const newestByKey = new Map<string, OpenFile>()
  for (const file of state.openFiles.filter((tab) => holdsAutosaveDraft(state, tab))) {
    const key = editorSaveKeyOfFile(state, file)
    const newest = newestByKey.get(key)
    if (!newest || editSeqOf(file.id) > editSeqOf(newest.id)) {
      newestByKey.set(key, file)
    }
  }
  const plans = new Map<string, PlannedAutoSave>()
  for (const [key, file] of newestByKey) {
    const draft = state.editorDrafts[file.id]
    // Why: suspension holds until the user picks a side via the banner (or saves manually).
    if (draft !== undefined && !heldKeys.has(key) && !isAutosaveSuspendedForFile(file)) {
      plans.set(key, { fileId: file.id, draft })
    }
  }
  return plans
}

export type DraftEditOrder = {
  /** Records which drafts changed since the last call; cheap when `editorDrafts` is unchanged. */
  note: (drafts: AppState['editorDrafts']) => void
  seqOf: (fileId: string) => number
}

/** Orders draft edits, so a model's newest text is known without per-tab timers racing. */
export function createDraftEditOrder(): DraftEditOrder {
  let counter = 0
  let last: AppState['editorDrafts'] = {}
  const seq = new Map<string, number>()
  return {
    note: (drafts) => {
      if (drafts === last) {
        return
      }
      for (const [id, draft] of Object.entries(drafts)) {
        if (last[id] !== draft) {
          seq.set(id, ++counter)
        }
      }
      for (const id of seq.keys()) {
        if (drafts[id] === undefined) {
          seq.delete(id)
        }
      }
      last = drafts
    },
    seqOf: (fileId) => seq.get(fileId) ?? 0
  }
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
