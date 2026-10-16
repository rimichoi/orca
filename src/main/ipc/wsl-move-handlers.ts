/**
 * IPC for the renderer half of a committed WSL move's desktop rewrite, and for bringing a moved
 * project back to this computer. Every channel answers empty / refuses while the internal WSL
 * hosts gate is closed.
 */
import { ipcMain, type WebContents } from 'electron'
import type {
  WslMovePendingRendererRewrite,
  WslMoveRecordStoreRewrittenResult
} from '../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import type { WslMoveUseLocallyResult } from '../../shared/wsl-move/wsl-moved-project'
import {
  listPendingWslMoveRendererRewrites,
  recordWslMoveRendererStoreRewritten
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import { bringWslMovedProjectBack } from '../persistence/moving-wsl-projects/wsl-move-use-locally'
import {
  holdReleasedWslMoveSessions,
  liftReleasedWslMoveSessionHolds
} from '../persistence/moving-wsl-projects/wsl-move-release-session-hold'

export const WSL_MOVE_HANDLER_CHANNELS = [
  'wslMove:listPendingRendererRewrites',
  'wslMove:recordStoreRewritten',
  'wslMove:useProjectHereAgain'
] as const

export function registerWslMoveHandlers(getUserDataPath: () => string): void {
  for (const channel of WSL_MOVE_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('wslMove:listPendingRendererRewrites', (): WslMovePendingRendererRewrite[] =>
    listPendingWslMoveRendererRewrites(getUserDataPath())
  )
  ipcMain.handle(
    'wslMove:recordStoreRewritten',
    (_event, request: unknown): WslMoveRecordStoreRewrittenResult => {
      // Renderer input: anything but two strings is an unknown store.
      if (
        typeof request !== 'object' ||
        request === null ||
        !('migrationId' in request) ||
        !('storeId' in request) ||
        typeof request.migrationId !== 'string' ||
        typeof request.storeId !== 'string'
      ) {
        return { recorded: false, reason: 'unknown-store' }
      }
      return recordWslMoveRendererStoreRewritten(getUserDataPath(), {
        migrationId: request.migrationId,
        storeId: request.storeId
      })
    }
  )
  ipcMain.handle(
    'wslMove:useProjectHereAgain',
    (event, request: unknown): WslMoveUseLocallyResult => {
      if (
        typeof request !== 'object' ||
        request === null ||
        !('kind' in request) ||
        !('id' in request) ||
        typeof request.id !== 'string' ||
        (request.kind !== 'repo' && request.kind !== 'folder')
      ) {
        return { released: false, reason: 'not-moved' }
      }
      const ref =
        request.kind === 'repo' ? { repoId: request.id } : { folderWorkspaceId: request.id }
      const result = bringWslMovedProjectBack(getUserDataPath(), ref)
      if (result.released) {
        reloadWithSessionHeld(event.sender, result)
      }
      return result
    }
  )
}

/**
 * The page holds only the project's chats; reloading hydrates its whole pre-move session from
 * disk. The hold keeps that session frozen until the new page loaded, so the old page's last
 * save cannot overwrite it.
 */
function reloadWithSessionHeld(
  sender: WebContents,
  scope: { repoIds: string[]; folderWorkspaceIds: string[] }
): void {
  holdReleasedWslMoveSessions(scope)
  const lift = (): void => liftReleasedWslMoveSessionHolds()
  sender.once('did-finish-load', lift)
  sender.once('destroyed', lift)
  // After the reply reaches the renderer, so its awaited call settles first.
  setImmediate(() => {
    if (!sender.isDestroyed()) {
      sender.reload()
    }
  })
}
