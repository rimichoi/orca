import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import {
  isAutosaveSuspendedForFile,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from './editor-autosave'
import { flushPendingEditorBuffer, hasPendingEditorBufferChange } from './editor-pending-flush'
import {
  editorSaveKeyOfFile,
  editorScheduleKeyOfFile,
  planAutoSaves,
  samePlannedAutoSave,
  sharedModelAutosaveText,
  sharesCodeViewModel,
  type PlannedAutoSave
} from './editor-model-autosave-plan'
import { currentTabText, settleCodeViewSiblingsAfterWrite } from './editor-model-sibling-settle'
import { createAutoSaveHolds } from './editor-autosave-holds'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { isEditorLargePasteInFlight } from './editor-large-paste-in-flight'
import {
  rebaselineAfterEditorWrite,
  setModelExternalMutation,
  waitForModelBaselineRestamps
} from './editor-save-rebaseline'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import {
  editorSavePrecondition,
  editorTabModelUri,
  writeEditorSave,
  type EditorSaveResult,
  type EditorSaveTrigger
} from './editor-save-disk-precondition'

export type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

export type EditorSaveQueue = {
  queueSave: (
    file: OpenFile,
    fallbackContent: string,
    trigger?: EditorSaveTrigger
  ) => Promise<EditorSaveResult>
  quiesceFileSave: (fileId: string) => Promise<void>
  clearAutoSaveTimer: (fileId: string) => void
  bumpSaveGeneration: (fileId: string) => void
  /** Pauses autosave for these save keys until the returned release runs (or the backstop lapses). */
  holdAutoSave: (keys: ReadonlySet<string>) => () => void
  syncAutoSave: () => void
  dispose: () => void
}

/** Which saves run in turn (`queue`) and which share one autosave timer and save generation (`schedule`). */
export type EditorSaveKeys = {
  queue: (state: AppState, fileId: string) => string
  schedule: (state: AppState, fileId: string) => string
}

function keyOfFileId(keyOf: (state: AppState, file: OpenFile) => string) {
  return (state: AppState, fileId: string): string => {
    const file = state.openFiles.find((openFile) => openFile.id === fileId)
    return file ? keyOf(state, file) : fileId
  }
}

// Why: tabs of one model share text and baseline, so saves run in turn; code-view tabs also share
// one timer and generation, so one workspace's quiesce or Discard cancels the other's autosave.
export const EDITOR_SAVE_KEYS: EditorSaveKeys = {
  queue: keyOfFileId(editorSaveKeyOfFile),
  schedule: keyOfFileId(editorScheduleKeyOfFile)
}

// Why: keeping the save queue, quiesce coordination, and the debounce timers that feed it together avoids split-brain saves.
export function createEditorSaveQueue(store: AppStoreApi): EditorSaveQueue {
  const keys = EDITOR_SAVE_KEYS
  // Keyed by `keys.schedule`.
  const autoSaveTimers = new Map<string, number>()
  const autoSaveScheduled = new Map<string, PlannedAutoSave>()
  const saveGeneration = new Map<string, number>()
  // Why per tab too: another tab's quiesce must cancel this model's autosave, not the user's own save.
  const tabSaveGeneration = new Map<string, number>()
  // Draft a tab held when another tab's write left it unverifiable; autosave skips it until it changes.
  const unverifiedDrafts = new Map<string, string>()
  const isUnverified = (file: OpenFile): boolean =>
    unverifiedDrafts.has(file.id) &&
    unverifiedDrafts.get(file.id) === store.getState().editorDrafts[file.id]
  // Keyed by `keys.queue`.
  const saveQueue = new Map<string, Promise<EditorSaveResult>>()

  const saveQueueKey = (fileId: string): string => keys.queue(store.getState(), fileId)
  const scheduleKeyOf = (fileId: string): string => keys.schedule(store.getState(), fileId)

  const clearScheduledAutoSave = (key: string): void => {
    window.clearTimeout(autoSaveTimers.get(key))
    autoSaveTimers.delete(key)
    autoSaveScheduled.delete(key)
  }

  const holds = createAutoSaveHolds(store.getState, () => syncAutoSave())

  const clearAutoSaveTimer = (fileId: string): void => clearScheduledAutoSave(scheduleKeyOf(fileId))

  const bumpSaveGeneration = (fileId: string): void => {
    const key = scheduleKeyOf(fileId)
    saveGeneration.set(key, (saveGeneration.get(key) ?? 0) + 1)
    tabSaveGeneration.set(fileId, (tabSaveGeneration.get(fileId) ?? 0) + 1)
  }

  const queueSave = (
    file: OpenFile,
    fallbackContent: string,
    trigger: EditorSaveTrigger = 'user'
  ): Promise<EditorSaveResult> => {
    const scheduleKey = scheduleKeyOf(file.id)
    clearScheduledAutoSave(scheduleKey)
    const generationOf = (): number =>
      (trigger === 'autosave' ? saveGeneration.get(scheduleKey) : tabSaveGeneration.get(file.id)) ??
      0
    const queuedGeneration = generationOf()
    const queueKey = saveQueueKey(file.id)

    const previousSave = saveQueue.get(queueKey) ?? Promise.resolve()
    const queuedSave = previousSave
      .catch(() => undefined)
      .then(async (): Promise<EditorSaveResult> => {
        await waitForModelBaselineRestamps(store.getState(), file)
        if (generationOf() !== queuedGeneration) {
          return 'failed'
        }

        const state = store.getState()
        const liveFile = state.openFiles.find((openFile) => openFile.id === file.id) ?? null
        if (!liveFile) {
          return 'failed'
        }
        if (liveFile.csvPreviewOnly === true) {
          throw new Error('Large CSV previews are read-only.')
        }

        // Why: read-only tabs (AI Vault View Log) must never write the agent-owned artifact through editor paths.
        if (liveFile.readOnly === true) {
          return 'failed'
        }

        if (liveFile.pendingOwnerMigration === true) {
          if (trigger === 'autosave') {
            return 'failed'
          }
          throw new Error('This file is still restoring its workspace owner. Try saving again.')
        }

        // Why: only autosave is blocked while suspended; explicit user saves proceed (the banner warned).
        if (
          trigger === 'autosave' &&
          (isAutosaveSuspendedForFile(liveFile) ||
            isEditorLargePasteInFlight(editorTabModelUri(state, liveFile)))
        ) {
          return 'failed'
        }

        flushPendingEditorBuffer(store.getState(), file.id, trigger === 'autosave')
        // Why: another code-view tab's stored draft may be a stale snapshot; the model is current.
        const sharedModel = trigger === 'autosave' && sharesCodeViewModel(state, liveFile)
        const contentToSave = sharedModel
          ? sharedModelAutosaveText(store.getState(), liveFile)
          : (store.getState().editorDrafts[file.id] ?? fallbackContent)
        if (
          contentToSave === undefined ||
          (trigger === 'autosave' &&
            ((hasPendingEditorBufferChange(store.getState(), file.id) &&
              liveFile.lastKnownDiskSignature === getDiskBaselineSignature(contentToSave)) ||
              isUnverified(liveFile) ||
              holds.heldKeys().has(queueKey)))
        ) {
          return 'failed'
        }
        const worktree = liveFile.worktreeId
          ? findWorktreeById(state.worktreesByRepo ?? {}, liveFile.worktreeId)
          : null
        const fileContext = getEditorFileOperationContext(state, liveFile, worktree?.path ?? null)
        const connectionId = fileContext.connectionId
        const precondition = editorSavePrecondition(liveFile, trigger)
        if (precondition.kind === 'blocked') {
          // Why: a mobile refusal is reported to mobile; the desktop tab may not even be dirty.
          if (trigger !== 'mobile') {
            setModelExternalMutation(store.getState(), file.id, 'changed')
          }
          return 'blocked-stale'
        }
        // Why: stamp before writing so useEditorExternalWatch ignores our own fs:changed echo (editor-self-write-registry).
        recordSelfWrite(
          liveFile.filePath,
          contentToSave,
          liveFile.runtimeEnvironmentId,
          connectionId || liveFile.runtimeEnvironmentId?.trim()
            ? SELF_WRITE_REMOTE_TTL_MS
            : undefined
        )
        let writeResult: FileWriteResult
        try {
          writeResult = await writeEditorSave(
            fileContext,
            liveFile.filePath,
            contentToSave,
            editorTabFileAccess(state, liveFile),
            precondition
          )
        } catch (error) {
          // Why: the self-write stamp is only valid after a real write; clear on failure so it can't suppress a real update.
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          throw error
        }
        if (!writeResult.ok) {
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          // Why: the banner (or deleted tombstone) explains the refusal and pauses autosave.
          if (trigger !== 'mobile') {
            setModelExternalMutation(
              store.getState(),
              file.id,
              writeResult.diskConflict === 'missing' ? 'deleted' : 'changed'
            )
          }
          return 'blocked-stale'
        }

        // Why before the superseded check: disk holds this text either way, so the next save compares against it.
        rebaselineAfterEditorWrite(store.getState(), file.id, contentToSave)
        if (generationOf() !== queuedGeneration) {
          return 'written'
        }

        const nextState = store.getState()
        for (const tab of settleCodeViewSiblingsAfterWrite(nextState, liveFile, contentToSave)) {
          unverifiedDrafts.set(tab.id, nextState.editorDrafts[tab.id] ?? '')
        }
        const currentDraft = currentTabText(nextState, liveFile)
        const stillDirty =
          (currentDraft !== undefined && currentDraft !== contentToSave) ||
          hasPendingEditorBufferChange(nextState, file.id)
        nextState.markFileDirty(file.id, stillDirty)
        if (!stillDirty) {
          nextState.clearEditorDraft(file.id)
        }
        // Why: disk now holds contentToSave, so a pending restore verification is moot.
        nextState.clearPendingDiskBaselineVerification(file.id)
        // Why: the write made disk match the buffer, so clear any now-stale changed-on-disk conflict.
        const savedFile = nextState.openFiles.find((openFile) => openFile.id === file.id)
        if (savedFile?.externalMutation === 'changed') {
          trackExternalChangeConflictAction(savedFile, 'save_overwrite')
          nextState.setExternalMutation(file.id, null)
        }

        window.dispatchEvent(
          new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
            detail: { fileId: file.id, content: contentToSave }
          })
        )
        return 'written'
      })

    let trackedSave: Promise<EditorSaveResult>
    trackedSave = queuedSave.finally(() => {
      if (saveQueue.get(queueKey) === trackedSave) {
        saveQueue.delete(queueKey)
      }
    })
    saveQueue.set(queueKey, trackedSave)
    return trackedSave
  }

  const quiesceFileSave = async (fileId: string): Promise<void> => {
    // Why: rich markdown debounces serialization, so force the pending draft out before we cancel timers.
    flushPendingEditorBuffer(store.getState(), fileId)
    const pendingSave = saveQueue.get(saveQueueKey(fileId))
    clearAutoSaveTimer(fileId)
    bumpSaveGeneration(fileId)
    await pendingSave?.catch(() => undefined)
  }

  const syncAutoSave = (): void => {
    const state = store.getState()
    const plans = state.settings?.editorAutoSave
      ? planAutoSaves(
          state,
          (file) => isUnverified(file) || holds.heldKeys().has(editorSaveKeyOfFile(state, file))
        )
      : new Map<string, PlannedAutoSave>()
    for (const key of Array.from(autoSaveTimers.keys())) {
      const plan = plans.get(key)
      if (!plan || !samePlannedAutoSave(autoSaveScheduled.get(key), plan)) {
        clearScheduledAutoSave(key)
      }
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings?.editorAutoSaveDelayMs)
    for (const [key, plan] of plans) {
      if (autoSaveTimers.has(key)) {
        continue
      }
      autoSaveScheduled.set(key, plan)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(key)
        autoSaveScheduled.delete(key)
        const file = store.getState().openFiles.find((openFile) => openFile.id === plan.fileId)
        if (file) {
          // Why fallback: queueSave re-reads the draft (or, for a shared model, its live text).
          void queueSave(file, plan.drafts[0], 'autosave').catch((error) => {
            console.error('[editor] autosave failed', error)
          })
        }
      }, autoSaveDelayMs)
      autoSaveTimers.set(key, timerId)
    }
  }

  const dispose = (): void => {
    autoSaveTimers.forEach((timerId) => window.clearTimeout(timerId))
    holds.dispose()
    autoSaveTimers.clear()
    autoSaveScheduled.clear()
    saveQueue.clear()
    saveGeneration.clear()
    unverifiedDrafts.clear()
    tabSaveGeneration.clear()
  }

  return {
    queueSave,
    quiesceFileSave,
    clearAutoSaveTimer,
    bumpSaveGeneration,
    holdAutoSave: holds.hold,
    syncAutoSave,
    dispose
  }
}
