import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { tabGroup, terminalTab } from '../__fixtures__/wsl-mover/wsl-mover-profile-rows'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
import { wslMoveHostSessionSeed, wslMoveSessionGlobalsPatch } from './wsl-move-session-rewrite'

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const scope = wslMoveRewriteScope({
  cutover: wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: ['repo-a'] }),
  rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
  destinationHostId: HOST
})

const source = wslMoverProfile('mixed-windows-wsl', 'source')
const MOVED = source.session.activeWorktreeId ?? ''
const MOVED_ON_HOST = 'repo-a::/home/dev/app'
const FEATURE_ON_HOST = 'repo-a::/home/dev/app-feature'
const SAME_DISTRO_ON_HOST = 'repo-b::/home/dev/lib'

const chatTab: Tab = {
  id: 'chat-1',
  entityId: 'agent-session-1',
  groupId: 'group-1',
  worktreeId: MOVED_ON_HOST,
  contentType: 'agent-session',
  label: 'Claude',
  customLabel: null,
  color: null,
  sortOrder: 1,
  createdAt: 0
}

/** The session the move carried, as the manifest holds it: host ids, a chat, live PTY ids. */
function carriedSession(): WorkspaceSessionState {
  const carried: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    ...wslMoverProfile('mixed-windows-wsl', 'destination').session
  }
  const group = carried.tabGroups?.[MOVED_ON_HOST]?.[0]
  return {
    ...carried,
    unifiedTabs: {
      ...carried.unifiedTabs,
      [MOVED_ON_HOST]: [...(carried.unifiedTabs?.[MOVED_ON_HOST] ?? []), chatTab]
    },
    tabGroups: {
      [MOVED_ON_HOST]: group
        ? [
            {
              ...group,
              tabOrder: [...group.tabOrder, chatTab.id],
              activeTabId: chatTab.id,
              recentTabIds: ['tab-1', chatTab.id]
            }
          ]
        : []
    },
    activeTabIdByWorktree: { [MOVED_ON_HOST]: chatTab.id },
    activeTabTypeByWorktree: { [MOVED_ON_HOST]: 'agent-session' }
  }
}

describe('WSL move session globals', () => {
  it("moves local focus on a moved workspace to the host's id and host", () => {
    expect(
      wslMoveSessionGlobalsPatch(
        {
          activeWorktreeId: MOVED,
          activeWorkspaceKey: `worktree:${MOVED}`,
          activeWorkspaceExecutionHostId: 'local'
        },
        scope
      )
    ).toEqual({
      activeWorktreeId: MOVED_ON_HOST,
      activeWorkspaceKey: `worktree:${MOVED_ON_HOST}`,
      activeWorkspaceExecutionHostId: HOST
    })
  })

  it('leaves focus on another project, or already on a host, alone', () => {
    const windows = 'repo-win::C:\\src\\win'
    expect(
      wslMoveSessionGlobalsPatch(
        { activeWorktreeId: windows, activeWorkspaceExecutionHostId: 'local' },
        scope
      )
    ).toBeNull()
    expect(
      wslMoveSessionGlobalsPatch(
        { activeWorktreeId: MOVED, activeWorkspaceExecutionHostId: 'ssh:box' },
        scope
      )
    ).toBeNull()
  })

  it('changes nothing on a second run', () => {
    const first = { activeWorktreeId: MOVED, activeWorkspaceExecutionHostId: null }
    const patch = wslMoveSessionGlobalsPatch(first, scope)

    expect(patch).toEqual({ activeWorktreeId: MOVED_ON_HOST, activeWorkspaceExecutionHostId: HOST })
    expect(wslMoveSessionGlobalsPatch({ ...first, ...patch }, scope)).toBeNull()
  })
})

describe('WSL move host session seed', () => {
  it("seeds only the moved project's rows, without chats or PTY bindings", () => {
    const seed = wslMoveHostSessionSeed(carriedSession(), getDefaultWorkspaceSession(), scope)

    expect(Object.keys(seed?.tabsByWorktree ?? {}).sort()).toEqual([MOVED_ON_HOST, FEATURE_ON_HOST])
    expect(seed?.tabsByWorktree[MOVED_ON_HOST]?.map((tab) => tab.ptyId)).toEqual([null])
    expect(seed?.terminalLayoutsByTabId['tab-1']?.ptyIdsByLeafId).toBeUndefined()
    expect(seed?.terminalLayoutsByTabId['tab-1']?.titlesByLeafId).toEqual({
      'leaf-1': 'build',
      'leaf-2': 'claude'
    })
    expect(seed?.terminalLayoutsByTabId['tab-3']).toBeUndefined()
    expect(seed?.remoteSessionIdsByTabId ?? {}).toEqual({})
    expect(seed?.terminalPtyIncarnationsByPaneKey ?? {}).toEqual({})
    expect(seed?.activeWorktreeIdsOnShutdown ?? []).toEqual([])
    expect(seed?.unifiedTabs?.[MOVED_ON_HOST]?.map((tab) => tab.id)).not.toContain(chatTab.id)
    expect(seed?.tabGroups?.[MOVED_ON_HOST]?.[0]).toMatchObject({
      tabOrder: ['tab-1', '/home/dev/app/README.md'],
      activeTabId: 'tab-1',
      recentTabIds: ['tab-1']
    })
    expect(seed?.activeTabIdByWorktree?.[MOVED_ON_HOST]).toBeUndefined()
    expect(seed?.activeTabTypeByWorktree?.[MOVED_ON_HOST]).toBeUndefined()
    expect(seed?.openFilesByWorktree?.[MOVED_ON_HOST]?.[0]?.dirtyDraftContent).toBe(
      '# unsaved draft'
    )
    // Focus belongs to whoever looks at the host, not to the seed.
    expect(seed?.activeWorktreeId).toBeNull()
    expect(seed?.tabsByWorktree[SAME_DISTRO_ON_HOST]).toBeUndefined()
  })

  it('never replaces what the host already published', () => {
    const published: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: MOVED_ON_HOST,
      tabsByWorktree: {
        [MOVED_ON_HOST]: [terminalTab('host-tab', MOVED_ON_HOST, null, 'host-pty')]
      },
      terminalLayoutsByTabId: {
        'host-tab': { root: null, activeLeafId: null, expandedLeafId: null }
      },
      tabGroups: { [MOVED_ON_HOST]: [tabGroup('host-group', MOVED_ON_HOST, ['host-tab'])] }
    }
    const seed = wslMoveHostSessionSeed(carriedSession(), published, scope)

    expect(seed?.tabsByWorktree[MOVED_ON_HOST]).toEqual(published.tabsByWorktree[MOVED_ON_HOST])
    expect(seed?.tabGroups).toEqual(published.tabGroups)
    expect(seed?.terminalLayoutsByTabId['tab-1']).toBeUndefined()
    expect(seed?.tabsByWorktree[FEATURE_ON_HOST]?.map((tab) => tab.id)).toEqual(['tab-2'])
    expect(seed?.activeWorktreeId).toBe(MOVED_ON_HOST)
  })

  it('changes nothing on a second run', () => {
    const seed = wslMoveHostSessionSeed(carriedSession(), getDefaultWorkspaceSession(), scope)

    if (!seed) {
      throw new Error('expected a seed')
    }
    expect(wslMoveHostSessionSeed(carriedSession(), seed, scope)).toBeNull()
  })
})
