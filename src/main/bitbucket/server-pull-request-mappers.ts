import type {
  CheckStatus,
  PRMergeableState,
  PRReviewDecision
} from '../../shared/github/pull-request-types'
import type { BitbucketPullRequestInfo } from './pull-request-mappers'

export type RawBitbucketServerRef = {
  id?: string
  displayId?: string
  latestCommit?: string
}

export type RawBitbucketServerReviewer = {
  user?: { name?: string }
  status?: string
}

export type RawBitbucketServerPullRequest = {
  id?: number
  title?: string
  state?: string | null
  updatedDate?: number
  fromRef?: RawBitbucketServerRef
  toRef?: RawBitbucketServerRef
  reviewers?: readonly RawBitbucketServerReviewer[]
  links?: { self?: readonly { href?: string }[] }
}

export type RawBitbucketServerMerge = {
  canMerge?: boolean
  conflicted?: boolean
  outcome?: string
}

export type RawBitbucketServerBuildStats = {
  successful?: number
  inProgress?: number
  failed?: number
}

export function mapBitbucketServerState(
  state: string | null | undefined
): BitbucketPullRequestInfo['state'] {
  const normalized = state?.trim().toUpperCase()
  if (normalized === 'MERGED') {
    return 'merged'
  }
  return normalized === 'DECLINED' ? 'closed' : 'open'
}

export function deriveBitbucketServerBuildStatus(
  stats: RawBitbucketServerBuildStats | null
): CheckStatus {
  if ((stats?.failed ?? 0) > 0) {
    return 'failure'
  }
  if ((stats?.inProgress ?? 0) > 0) {
    return 'pending'
  }
  return (stats?.successful ?? 0) > 0 ? 'success' : 'neutral'
}

// Why: canMerge is also false for vetoes such as missing approvals, which are not conflicts.
export function deriveBitbucketServerMergeable(
  merge: RawBitbucketServerMerge | null
): PRMergeableState {
  if (merge?.conflicted) {
    return 'CONFLICTING'
  }
  return merge?.outcome?.toUpperCase() === 'CLEAN' ? 'MERGEABLE' : 'UNKNOWN'
}

export function deriveBitbucketServerReviewDecision(
  reviewers: readonly RawBitbucketServerReviewer[] | undefined
): PRReviewDecision | null {
  if (!reviewers || reviewers.length === 0) {
    return null
  }
  const statuses = reviewers.map((reviewer) => reviewer.status?.toUpperCase())
  if (statuses.includes('NEEDS_WORK')) {
    return 'CHANGES_REQUESTED'
  }
  return statuses.includes('APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED'
}

export function mapBitbucketServerPullRequest(
  raw: RawBitbucketServerPullRequest,
  status: CheckStatus,
  mergeable: PRMergeableState
): BitbucketPullRequestInfo | null {
  const url = raw.links?.self?.[0]?.href
  if (typeof raw.id !== 'number' || !raw.title || !url) {
    return null
  }
  const headSha = raw.fromRef?.latestCommit?.trim()
  return {
    number: raw.id,
    title: raw.title,
    state: mapBitbucketServerState(raw.state),
    url,
    status,
    updatedAt: typeof raw.updatedDate === 'number' ? new Date(raw.updatedDate).toISOString() : '',
    mergeable,
    reviewDecision: deriveBitbucketServerReviewDecision(raw.reviewers),
    ...(headSha ? { headSha } : {})
  }
}
