import { envValue } from './bitbucket-auth-config'
import {
  getStoredBitbucketServerMetadata,
  hasStoredBitbucketServerCredential,
  loadStoredBitbucketServerSecret
} from './server-credential-store'

export type BitbucketServerAuthConfig = {
  baseUrl: string | null
  accessToken: string | null
}

export function normalizeBitbucketServerBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  // Why: users paste REST or browser URLs; the server root is everything before /rest/.
  const path = url.pathname.replace(/\/rest(\/.*)?$/i, '').replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

function envAuthConfig(): BitbucketServerAuthConfig {
  return {
    baseUrl: normalizeBitbucketServerBaseUrl(envValue('ORCA_BITBUCKET_SERVER_BASE_URL')),
    accessToken: envValue('ORCA_BITBUCKET_SERVER_TOKEN')
  }
}

export function hasEnvBitbucketServerCredential(): boolean {
  const env = envAuthConfig()
  return Boolean(env.baseUrl && env.accessToken)
}

// Plaintext only, never decrypts: called on every repo detection.
export function getBitbucketServerBaseUrl(): string | null {
  const env = envAuthConfig()
  if (env.baseUrl) {
    return env.baseUrl
  }
  return hasStoredBitbucketServerCredential()
    ? (getStoredBitbucketServerMetadata()?.baseUrl ?? null)
    : null
}

export function hasBitbucketServerCredential(): boolean {
  return hasEnvBitbucketServerCredential() || hasStoredBitbucketServerCredential()
}

export function resolveBitbucketServerAuthConfig(): BitbucketServerAuthConfig {
  const env = envAuthConfig()
  if (env.baseUrl && env.accessToken) {
    return env
  }
  try {
    const secret = loadStoredBitbucketServerSecret()
    return {
      baseUrl:
        env.baseUrl ?? getStoredBitbucketServerMetadata()?.baseUrl ?? secret?.baseUrl ?? null,
      accessToken: env.accessToken ?? secret?.accessToken ?? null
    }
  } catch {
    return { baseUrl: env.baseUrl, accessToken: env.accessToken }
  }
}

export function serverAuthHeaders(config: BitbucketServerAuthConfig): Record<string, string> {
  return config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}
}
