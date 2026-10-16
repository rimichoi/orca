import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  hasWslMoveFrozenSessions,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests
} from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))

import { registerWslMoveHandlers } from './wsl-move-handlers'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-ipc-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  registerWslMoveDesktopRewriteStore({ id: 'renderer-a', side: 'renderer' })
  seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
  registerWslMoveHandlers(() => userDataPath)
  loadWslMoveFence(userDataPath)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const invoke = (channel: string, request?: unknown) => handlers.get(channel)?.({}, request)

describe('WSL move IPC', () => {
  it('lists pending renderer rewrites and records one', () => {
    expect(invoke('wslMove:listPendingRendererRewrites')).toMatchObject([
      { migrationId: 'move-1', storeIds: ['renderer-a'] }
    ])
    expect(
      invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' })
    ).toEqual({ recorded: true })
    // The registry is incomplete until D1b-7f, so the move stays in its rewrite phase.
    expect(listWslMoveCutovers(userDataPath)[0]).toMatchObject({
      phase: 'destination-committed',
      rewrittenStores: ['renderer-a']
    })
  })

  it.each([
    undefined,
    null,
    'renderer-a',
    { migrationId: 'move-1' },
    { migrationId: 1, storeId: 2 }
  ])('refuses a malformed request %j', (request) => {
    expect(invoke('wslMove:recordStoreRewritten', request)).toEqual({
      recorded: false,
      reason: 'unknown-store'
    })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
  })

  it('answers empty and refuses with the gate closed', () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(invoke('wslMove:listPendingRendererRewrites')).toEqual([])
    expect(
      invoke('wslMove:recordStoreRewritten', { migrationId: 'move-1', storeId: 'renderer-a' })
    ).toEqual({ recorded: false, reason: 'gated-off' })
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
  })

  it('brings a moved project back, validating the renderer input', async () => {
    for (const bad of [undefined, null, { kind: 'repo' }, { kind: 'x', id: 'repo-1' }]) {
      expect(invoke('wslMove:useProjectHereAgain', bad)).toEqual({
        released: false,
        reason: 'not-moved'
      })
    }
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)

    const listeners = new Map<string, () => void>()
    const sender = {
      once: (name: string, listener: () => void) => listeners.set(name, listener),
      isDestroyed: () => false,
      reload: vi.fn()
    }
    const result = handlers.get('wslMove:useProjectHereAgain')?.(
      { sender },
      { kind: 'repo', id: 'repo-1' }
    )
    expect(result).toMatchObject({ released: true })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    // The page held only chats: its session stays frozen until the reloaded page has loaded.
    expect(hasWslMoveFrozenSessions()).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(sender.reload).toHaveBeenCalledOnce()
    listeners.get('did-finish-load')?.()
    expect(hasWslMoveFrozenSessions()).toBe(false)
  })
})
