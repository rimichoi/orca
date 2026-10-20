// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../shared/agent-session-wire'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import { getWorktreeIdsWithStructuredChat } from '../sidebar/visible-worktree-activity-inputs'
import { selectIsSleepingWorktree } from '../sidebar/use-worktree-sleep-state'
import { hasSleepableWorkspaceActivity } from '../sidebar/workspace-lineage-menu-actions'
import { agentSessionTabFixture } from './native-chat-workspace-test-fixtures'
const mocks = vi.hoisted(() => ({ subscribeStatus: vi.fn(), supportsCapability: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))
import { useAppStore } from '@/store'
import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'
function emit(event: AgentSessionStatusEvent, index = 0): void {
  act(() => mocks.subscribeStatus.mock.calls[index][1](event))
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: vi.fn() })
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionStatusFeedsForTests()
})
it.each(['slept', 'disconnected', 'old-host'] as const)(
  'waits for host sleep evidence after restart: %s',
  async (answer) => {
    mocks.supportsCapability.mockResolvedValue(answer !== 'old-host')
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': [
          agentSessionTabFixture('chat', 'wt-1', {
            entityId: 'session-1',
            executionHostId: answer === 'old-host' ? 'runtime:old' : 'local'
          })
        ]
      },
      structuredChatSleptAtByPaneKey: {},
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      browserTabsByWorktree: {}
    })
    const visible = () => {
      const state = useAppStore.getState()
      return getWorktreeIdsWithStructuredChat(
        state.unifiedTabsByWorktree,
        state.structuredChatSleptAtByPaneKey
      ).has('wt-1')
    }
    expect(visible()).toBe(false)
    expect(selectIsSleepingWorktree(useAppStore.getState(), 'wt-1')).toBe(false)
    expect(hasSleepableWorkspaceActivity('wt-1', useAppStore.getState())).toBe(false)
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        ...useAppStore.getState(),
        browserTabsByWorktree: { 'wt-1': [{ id: 'browser' }] }
      })
    ).toBe(true)
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        ...useAppStore.getState(),
        tabsByWorktree: { 'wt-1': [{ id: 'terminal' }] },
        ptyIdsByTabId: { terminal: ['pty'] }
      })
    ).toBe(true)
    render(<StructuredAgentSessionStatusBridge />)
    if (answer === 'old-host') {
      await waitFor(() => expect(visible()).toBe(true))
      expect(mocks.subscribeStatus).not.toHaveBeenCalled()
      return
    }
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    expect(visible()).toBe(false)
    const session = {
      sessionId: 'session-1',
      workspaceId: 'wt-1',
      agent: 'codex',
      status: 'idle',
      latestPrompt: '',
      updatedAt: 1,
      sleptAt: 5
    } as const
    emit(answer === 'disconnected' ? { type: 'end' } : { type: 'snapshot', sessions: [session] })
    expect(visible()).toBe(false)
    expect(selectIsSleepingWorktree(useAppStore.getState(), 'wt-1')).toBe(answer === 'slept')
    expect(hasSleepableWorkspaceActivity('wt-1', useAppStore.getState())).toBe(false)
    if (answer === 'disconnected') {
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
      emit({ type: 'snapshot', sessions: [session] }, 1)
      expect(visible()).toBe(false)
      expect(selectIsSleepingWorktree(useAppStore.getState(), 'wt-1')).toBe(true)
    }
    if (answer === 'slept') {
      emit({ type: 'end' })
      expect(visible()).toBe(false)
      cleanup()
      render(<StructuredAgentSessionStatusBridge />)
      expect(visible()).toBe(false)
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
      emit({ type: 'status', session: { ...session, sleptAt: undefined } }, 1)
      expect(visible()).toBe(true)
    }
  }
)
