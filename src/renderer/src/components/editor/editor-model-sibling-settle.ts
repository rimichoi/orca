import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { notifyEditorFileCacheStale } from './editor-autosave'
import { hasPendingEditorBufferChange } from './editor-pending-flush'
import { editorModelSiblingTabs } from './editor-save-disk-precondition'
import { readLiveModelText, sharesCodeViewModel } from './editor-model-autosave-plan'

/**
 * Code-view tabs show the one model, so once disk holds the model's text they are all clean, even
 * one whose stored draft is a stale snapshot from before it unmounted (it would revert the model on
 * remount). Without a live model, only a tab whose own draft was written is clean; the others are
 * returned, since their different drafts can't be told stale from newer.
 */
export function settleCodeViewSiblingsAfterWrite(
  state: AppState,
  file: OpenFile,
  written: string
): OpenFile[] {
  const live = readLiveModelText(state, file)
  const unverified: OpenFile[] = []
  for (const tab of editorModelSiblingTabs(state, file)) {
    if (tab.id === file.id || !tab.isDirty || hasPendingEditorBufferChange(state, tab.id)) {
      continue
    }
    if ((live ?? state.editorDrafts[tab.id]) !== written) {
      if (live === undefined) {
        unverified.push(tab)
      }
      continue
    }
    state.markFileDirty(tab.id, false)
    state.clearEditorDraft(tab.id)
    notifyEditorFileCacheStale(tab.id)
  }
  return unverified
}

/** The text `file` shows now: a shared code-view model's live text, else its own draft. */
export function currentTabText(state: AppState, file: OpenFile): string | undefined {
  const draft = state.editorDrafts[file.id]
  return sharesCodeViewModel(state, file) ? (readLiveModelText(state, file) ?? draft) : draft
}
