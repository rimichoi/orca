import { ipcRenderer } from 'electron'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenRequest,
  WslMoveRecordStoreRewrittenResult
} from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import type {
  WslMovedProjectKind,
  WslMoveUseLocallyResult
} from '../../shared/wsl-move/wsl-moved-project'

/** The renderer half of a committed WSL move's desktop rewrite; main gates both calls. */
export type WslMoveApi = {
  listPendingRendererRewrites: () => Promise<WslMovePendingRendererRewrite[]>
  recordStoreRewritten: (
    request: WslMoveRecordStoreRewrittenRequest
  ) => Promise<WslMoveRecordStoreRewrittenResult>
  /** Drops the move that took this project, so its pre-move rows show here again. */
  useProjectHereAgain: (project: {
    kind: WslMovedProjectKind
    id: string
  }) => Promise<WslMoveUseLocallyResult>
}

export const wslMoveApi: WslMoveApi = {
  listPendingRendererRewrites: () => ipcRenderer.invoke('wslMove:listPendingRendererRewrites'),
  recordStoreRewritten: (request) => ipcRenderer.invoke('wslMove:recordStoreRewritten', request),
  useProjectHereAgain: (project) => ipcRenderer.invoke('wslMove:useProjectHereAgain', project)
}
