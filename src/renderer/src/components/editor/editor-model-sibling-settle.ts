import type { AppState } from '@/store'
import { getWrittenContentDiskSignature } from '../../../../shared/disk-baseline-signature'
import { notifyEditorFileCacheStale } from './editor-autosave'
import { hasPendingEditorBufferChange } from './editor-pending-flush'
import { editorSaveKeyOfFile, holdsAutosaveDraft } from './editor-model-autosave-plan'

/**
 * After a model write, other dirty tabs of the model: one holding the written text is now clean;
 * one whose different text is older than the saved tab's gets the changed-on-disk banner, so it can
 * never autosave over the newer write. A tab edited later keeps its newer text and its own autosave.
 */
export function settleModelSiblingsAfterWrite(
  state: AppState,
  written: { fileId: string; key: string; content: string; editSeq: number },
  seqOf: (fileId: string) => number
): void {
  for (const tab of state.openFiles) {
    if (
      tab.id === written.fileId ||
      !holdsAutosaveDraft(state, tab) ||
      hasPendingEditorBufferChange(state, tab.id) ||
      editorSaveKeyOfFile(state, tab) !== written.key
    ) {
      continue
    }
    if (state.editorDrafts[tab.id] !== written.content) {
      if (seqOf(tab.id) < written.editSeq) {
        state.setExternalMutation(tab.id, 'changed')
      }
      continue
    }
    state.setLastKnownDiskSignature(tab.id, getWrittenContentDiskSignature(written.content))
    state.markFileDirty(tab.id, false)
    state.clearEditorDraft(tab.id)
    state.clearPendingDiskBaselineVerification(tab.id)
    notifyEditorFileCacheStale(tab.id)
  }
}
