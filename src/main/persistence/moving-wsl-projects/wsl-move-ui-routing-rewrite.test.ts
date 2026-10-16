import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceCleanupDismissal } from '../../../shared/workspace-cleanup'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
import { rewriteWslMoveUiRouting, type WslMoveUiRoutingState } from './wsl-move-ui-routing-rewrite'

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const scope = wslMoveRewriteScope({
  cutover: wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: ['repo-a'] }),
  rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
  destinationHostId: HOST
})

// The mixed profile: repo-a moves; repo-b (same distro), repo-win and repo-deb stay.
const source = wslMoverProfile('mixed-windows-wsl', 'source')
const destination = wslMoverProfile('mixed-windows-wsl', 'destination')
const sourceRepo = (id: string): string =>
  source.state.repos.find((repo) => repo.id === id)?.path ?? ''
const MOVED = `repo-a::${sourceRepo('repo-a')}`
const MOVED_ON_HOST = 'repo-a::/home/dev/app'
const SAME_DISTRO = `repo-b::${sourceRepo('repo-b')}`
const WINDOWS = `repo-win::${sourceRepo('repo-win')}`
const SSH = 'ssh:box' as const
const sourceUi = source.ui ?? {}
const destinationUi = destination.ui ?? {}

function profileUi(): WslMoveUiRoutingState {
  const ui = sourceUi
  return {
    lastActiveWorktreeId: ui.lastActiveWorktreeId ?? null,
    showDotfilesByWorktree: {
      ...ui.showDotfilesByWorktree,
      [SAME_DISTRO]: false
    },
    explorerDisplayRootByWorktree: {
      ...ui.explorerDisplayRootByWorktree,
      [WINDOWS]: 'C:\\src\\win\\lib'
    },
    workspaceCleanup: {
      dismissals: {
        [`local\0${MOVED}`]: dismissal(MOVED, 'local'),
        [`${SSH}\0${MOVED}`]: dismissal(MOVED, SSH),
        [SAME_DISTRO]: dismissal(SAME_DISTRO)
      }
    },
    manualRepoOrder: [
      { hostId: 'local', repoId: 'repo-win' },
      ...(ui.manualRepoOrder ?? []),
      { hostId: 'local', repoId: 'repo-b' },
      { hostId: SSH, repoId: 'repo-a' }
    ],
    workspaceHostScope: 'local',
    visibleWorkspaceHostIds: null,
    agentsVisibleHostIds: [SSH, 'local'],
    workspaceHostOrder: ['local', SSH],
    setupScriptPromptDismissedRepoIds: [
      'generation-v1:local\0repo-a',
      'generation-v1:local\0repo-b',
      `generation-v1:${SSH}\0repo-a`
    ],
    collapsedGroups: [
      `lineage:local|${MOVED}`,
      `lineage:${SSH}|${MOVED}`,
      `lineage:local|${SAME_DISTRO}`,
      'repo:repo-a'
    ]
  }
}

function dismissal(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): WorkspaceCleanupDismissal {
  return {
    worktreeId,
    dismissedAt: 1,
    fingerprint: 'f',
    classifierVersion: 1,
    ...(executionHostId ? { executionHostId } : {})
  }
}

describe('WSL move UI routing rewrite', () => {
  it("routes only the moved project's rows to the host, as the host holds them", () => {
    const updates = rewriteWslMoveUiRouting(profileUi(), scope)

    expect(updates.lastActiveWorktreeId).toBe(destinationUi.lastActiveWorktreeId)
    expect(updates.showDotfilesByWorktree).toEqual({
      ...destinationUi.showDotfilesByWorktree,
      [SAME_DISTRO]: false
    })
    expect(updates.explorerDisplayRootByWorktree).toEqual({
      ...destinationUi.explorerDisplayRootByWorktree,
      [WINDOWS]: 'C:\\src\\win\\lib'
    })
    expect(updates.workspaceCleanup?.dismissals).toEqual({
      [`${HOST}\0${MOVED_ON_HOST}`]: {
        ...dismissal(MOVED_ON_HOST),
        executionHostId: HOST
      },
      [`${SSH}\0${MOVED}`]: dismissal(MOVED, SSH),
      [SAME_DISTRO]: dismissal(SAME_DISTRO)
    })
    expect(updates.manualRepoOrder).toEqual([
      { hostId: 'local', repoId: 'repo-win' },
      { hostId: HOST, repoId: 'repo-a' },
      { hostId: 'local', repoId: 'repo-b' },
      { hostId: SSH, repoId: 'repo-a' }
    ])
  })

  it('adds the host wherever local is shown, and never removes local', () => {
    const updates = rewriteWslMoveUiRouting(profileUi(), scope)

    // The legacy `local` scope resolves to a list, so the host joins it there.
    expect(updates.visibleWorkspaceHostIds).toEqual(['local', HOST])
    expect(updates.workspaceHostScope).toBeUndefined()
    expect(updates.agentsVisibleHostIds).toEqual([SSH, 'local', HOST])
    expect(updates.workspaceHostOrder).toEqual(['local', HOST, SSH])
  })

  it('leaves host filters that do not show local, or show all hosts, alone', () => {
    const updates = rewriteWslMoveUiRouting(
      {
        ...profileUi(),
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: null,
        agentsVisibleHostIds: [SSH],
        workspaceHostOrder: undefined
      },
      scope
    )

    expect(updates.visibleWorkspaceHostIds).toBeUndefined()
    expect(updates.agentsVisibleHostIds).toBeUndefined()
    expect(updates.workspaceHostOrder).toBeUndefined()
  })

  it('keeps the local setup-prompt dismissal and lineage group beside the host ones', () => {
    const ui = profileUi()
    const updates = rewriteWslMoveUiRouting(ui, scope)

    expect(updates.setupScriptPromptDismissedRepoIds).toEqual([
      ...(ui.setupScriptPromptDismissedRepoIds ?? []),
      `generation-v1:${HOST}\0repo-a`
    ])
    expect(updates.collapsedGroups).toEqual([
      ...ui.collapsedGroups,
      `lineage:${HOST}|${MOVED_ON_HOST}`
    ])
  })

  it('changes nothing on a second run', () => {
    const first = {
      ...profileUi(),
      ...rewriteWslMoveUiRouting(profileUi(), scope)
    }

    expect(rewriteWslMoveUiRouting(first, scope)).toEqual({})
  })

  it('changes nothing for a UI that never named the moved project', () => {
    const ui: WslMoveUiRoutingState = {
      lastActiveWorktreeId: WINDOWS,
      showDotfilesByWorktree: { [SAME_DISTRO]: true },
      collapsedGroups: [`lineage:local|${WINDOWS}`],
      manualRepoOrder: [{ hostId: 'local', repoId: 'repo-win' }],
      agentsVisibleHostIds: null
    }

    expect(rewriteWslMoveUiRouting(ui, scope)).toEqual({})
  })
})
