import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { Repo } from '../../../shared/repo-types'

/**
 * The repo row that returned a work item. A stamped item resolves on its own host, so a twin id
 * never lends it the other host's row; an unstamped one keeps the by-id row a repo map gives.
 */
export function getGitHubWorkItemRepo(
  repos: readonly Repo[],
  item: Pick<GitHubWorkItem, 'repoId' | 'repoHostId'>
): Repo | undefined {
  let byId: Repo | undefined
  let rowCount = 0
  for (const repo of repos) {
    if (repo.id !== item.repoId) {
      continue
    }
    if (item.repoHostId && getRepoExecutionHostId(repo) === item.repoHostId) {
      return repo
    }
    byId = repo
    rowCount += 1
  }
  // Why: only a twin needs the stamp; a lone row stays the item's row whatever it was stamped.
  return item.repoHostId && rowCount > 1 ? undefined : byId
}
