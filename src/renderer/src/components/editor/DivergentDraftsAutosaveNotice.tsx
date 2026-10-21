import React from 'react'
import { TriangleAlert } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isModelAutosavePausedByDivergentDrafts } from './editor-model-autosave-plan'

/** Explains why a dirty tab isn't autosaving: another tab of the file holds different text. */
export function DivergentDraftsAutosaveNotice({
  fileId
}: {
  fileId: string
}): React.JSX.Element | null {
  const paused = useAppStore((state) => isModelAutosavePausedByDivergentDrafts(state, fileId))
  if (!paused) {
    return null
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-status-warning-border bg-status-warning-background px-3 py-1.5 text-xs"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-status-warning" />
      <span className="min-w-0 font-medium text-foreground">
        {translate(
          'auto.components.editor.editor.save.divergentDrafts.notice',
          'Autosave is paused because another tab of this file has different unsaved edits. Save the version you want to keep.'
        )}
      </span>
    </div>
  )
}
