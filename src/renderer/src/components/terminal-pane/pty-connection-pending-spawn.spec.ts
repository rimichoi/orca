import { makePaneKey } from '../../../../shared/stable-pane-id'
import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionPendingSpawnTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      pendingSpawnByPaneKey.clear()
      await restoreTerminalTestGlobals()
    })

    it('does not retain PTY connect diagnostics unless e2e debug state is enabled', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks()

      expect((globalThis as Record<string, unknown>).__ptyConnectDiag).toBeUndefined()
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[pty-connect]'))
      logSpy.mockRestore()
    }, 30_000)

    it('does not hold a successor behind a canceled spawn serializer declaration', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      const declaration = createDeferred<number>()
      const spawn = createDeferred<null>()
      const transport = createMockTransport()
      transport.connect.mockReturnValueOnce(spawn.promise)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      vi.mocked(window.api.pty.declarePendingPaneSerializer).mockReturnValueOnce(
        declaration.promise
      )

      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks(12)
      expect(pendingSpawnByPaneKey.size).toBe(1)
      binding.dispose()
      spawn.resolve(null)
      await flushAsyncTicks(12)

      expect(pendingSpawnByPaneKey.size).toBe(0)
      expect(window.api.pty.clearPendingPaneSerializer).not.toHaveBeenCalled()

      declaration.resolve(7)
      await flushAsyncTicks(12)

      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        7
      )
    })

    it('resumes a held pending spawn on reveal after a hidden remount', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      const { getPaneSpawnDeferral } = await import('@/lib/pane-spawn-deferral-registry')
      const { requestSleepingAgentWakeOnMount } = await import('@/lib/sleeping-agent-wake-requests')
      const spawn = createDeferred<undefined>()
      const producer = createMockTransport()
      producer.connect.mockReturnValueOnce(spawn.promise)
      const receiver = createMockTransport()
      receiver.connect.mockImplementation(async () => {
        receiver.getPtyId.mockReturnValue('pty-revealed')
        return { id: 'pty-revealed' }
      })
      transportFactoryQueue.push(producer, receiver)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] }
      mockStoreState.ptyIdsByTabId = { 'tab-1': [] }
      mockStoreState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId = {}
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'held-session' },
        prompt: '',
        state: 'done',
        origin: 'worktree-sleep',
        capturedAt: 1,
        updatedAt: 1
      }
      mockStoreState.rememberSleepingAgentSession = vi.fn((record: { paneKey: string }) => {
        mockStoreState.sleepingAgentSessionsByPaneKey[record.paneKey] ??= record
      })
      mockStoreState.pendingStartupByTabId = {}
      mockStoreState.automaticAgentResumeClaimsByTabId = {}
      const deps = createDeps({ isVisibleRef: { current: false } })
      requestSleepingAgentWakeOnMount('wt-1', ['tab-1'])
      const first = connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(30)
      expect(producer.connect).toHaveBeenCalledTimes(1)
      expect(producer.connect.mock.calls[0][0].resumeSpawnIntent).toBe('automatic-restore')
      producer.connect.mock.calls[0][0].callbacks.onSpawnDeferred('live_cap')
      const selected = [...pendingSpawnByPaneKey.values()][0]
      first.dispose()
      const remount = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        deps as never
      )
      try {
        await flushAsyncTicks(30)
        expect(receiver.connect).not.toHaveBeenCalled()
        expect(pendingSpawnByPaneKey.size).toBe(1)
        spawn.resolve(undefined)
        await expect(selected).resolves.toMatchObject({ kind: 'held' })
        await flushAsyncTicks(50)
        expect(pendingSpawnByPaneKey.size).toBe(0)
        getPaneSpawnDeferral(paneKey)?.resume()
        await flushAsyncTicks(30)
        expect(receiver.connect).not.toHaveBeenCalled()
        deps.isVisibleRef.current = true
        remount.noteVisibilityResume()
        await flushAsyncTicks(80)
        expect(receiver.connect).toHaveBeenCalledTimes(1)
        expect(receiver.getPtyId()).toBe('pty-revealed')
        expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-revealed')
      } finally {
        remount.dispose()
      }
    })

    it('joins the selected nested spawn across a StrictMode remount', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pendingSpawn = createDeferred<string>()
      const firstTransport = createMockTransport()
      firstTransport.connect
        .mockResolvedValueOnce({ id: 'empty-adoption', isReattach: true })
        .mockReturnValueOnce(pendingSpawn.promise)
      vi.mocked(window.api.pty.declarePendingPaneSerializer)
        .mockResolvedValueOnce(11)
        .mockResolvedValueOnce(12)
      const remountTransport = createMockTransport()
      transportFactoryQueue.push(firstTransport, remountTransport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null, generation: 7 }] },
        sleepingAgentSessionsByPaneKey: {
          [makePaneKey('tab-1', LEAF_1)]: {
            paneKey: makePaneKey('tab-1', LEAF_1),
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'nested-session' },
            prompt: '',
            state: 'done',
            origin: 'worktree-sleep',
            capturedAt: 1,
            updatedAt: 1
          }
        },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      const remountDeps = createDeps()

      const firstBinding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps() as never
      )
      await flushAsyncTicks(20)
      expect(firstTransport.connect).toHaveBeenCalledTimes(2)
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(expect.any(String), 11)
      expect(
        vi.mocked(window.api.pty.clearPendingPaneSerializer).mock.invocationCallOrder[0]
      ).toBeLessThan(
        vi.mocked(window.api.pty.declarePendingPaneSerializer).mock.invocationCallOrder[1]
      )
      const { pendingSpawnByPaneKey } = await import('./pty-connection/pty-connect-limits')
      const selected = [...pendingSpawnByPaneKey.values()][0]
      firstBinding.dispose()
      connectPanePty(createPane(1) as never, createManager(1) as never, remountDeps as never)
      await flushAsyncTicks()

      expect(firstTransport.connect).toHaveBeenCalledTimes(2)
      expect(remountTransport.connect).not.toHaveBeenCalled()

      const spawnedPtyId = 'pty-strict-mode'
      pendingSpawn.resolve(spawnedPtyId)
      await expect(selected).resolves.toMatchObject({
        kind: 'connected',
        ptyId: spawnedPtyId,
        generation: 2
      })
      await flushAsyncTicks(12)
      expect(pendingSpawnByPaneKey.size).toBe(0)
      expect(window.api.pty.settlePaneSerializer).toHaveBeenCalledWith(expect.any(String), 12)

      expect(remountTransport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: spawnedPtyId })
      )
      expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith('tab-1', spawnedPtyId)
    })
  })
}
