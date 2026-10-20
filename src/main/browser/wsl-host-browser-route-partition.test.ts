import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  browserAuthorityExecutionHostStorageIdentity,
  legacyBrowserNativeExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope
} from './browser-route-identity'
import { BrowserRoutePartitionBindingStore } from './browser-route-partition-binding-store'
import { supersededBrowserRoutePartitionIdentities } from './browser-route-partition-migration'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import {
  pairedRuntimeHostEnvironment,
  preW1AuthorityConnectionIdentity,
  type PairedRuntimeHostKind
} from './paired-runtime-browser-host-environment-fixture'
import {
  bindWslHostBrowserRoutePartition,
  wslHostBrowserRouteStorage
} from './wsl-host-browser-route-partition'

const bindings = vi.hoisted(() => ({ filePath: '' }))

vi.mock('./browser-route-partition-binding-runtime', () => ({
  currentBrowserRoutePartitionBindingStore: () =>
    new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
}))
vi.mock('./browser-route-partition-storage-dependencies', () => ({
  releaseEvictedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))

const orcaProfileId = 'orca-profile-a'
let directory: string

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'wsl-host-route-')))
  bindings.filePath = join(directory, 'bindings.json')
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function wslHost(revision: number, device: string): KnownRuntimeEnvironment {
  return pairedRuntimeHostEnvironment({
    kind: 'wsl',
    pairingRevision: revision,
    pairedDeviceId: device
  })
}

function stableStorage(environment: KnownRuntimeEnvironment) {
  const result = wslHostBrowserRouteStorage(orcaProfileId, environment)
  if (result.kind !== 'stable') {
    throw new Error(`expected a stable partition, got ${result.reason}`)
  }
  return result.storage
}

/** The partition the host's first in-app page lands in, after orcad relaunched at least once. */
async function firstPagePartition(
  environment: KnownRuntimeEnvironment,
  authorityRuntimeId: string,
  browserProfileId = 'default'
): Promise<string> {
  const storageScope = deriveBrowserRoutePartitionStorageScope({
    orcaProfileId,
    environmentId: environment.id
  })
  const authority = derivePairedRuntimeBrowserAuthorityIdentities({
    orcaProfileId,
    environment,
    connection: getPreferredPairedRuntimeConnection(environment),
    authorityRuntimeId
  })
  const executionHostIdentity = browserAuthorityExecutionHostStorageIdentity(storageScope)
  const store = new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
  const registry = new BrowserRouteSessionRegistry({
    validateProfile: vi.fn(),
    getSession: () => ({
      setProxy: vi.fn(async () => {}),
      closeAllConnections: vi.fn(async () => {}),
      resolveProxy: vi.fn(async () => 'SOCKS5 127.0.0.1:43123')
    }),
    setupPolicies: vi.fn(),
    clearPolicies: vi.fn(),
    retirePageAuthority: vi.fn(() => true),
    bindingStore: {
      get: (partition) => store.get(partition),
      set: (partition, fingerprint, scope) => store.set(partition, fingerprint, scope),
      touch: (partition) => store.touch(partition),
      findPartitionByFingerprint: (fingerprint) => store.findPartitionByFingerprint(fingerprint),
      rebind: (partition, fingerprint, scope) => store.rebind(partition, fingerprint, scope)
    }
  })
  const handle = await registry.preparePage({
    identity: {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: authority.authorityConnectionIdentity,
      executionHostIdentity
    },
    legacyIdentities: supersededBrowserRoutePartitionIdentities({
      ...authority,
      orcaProfileId,
      browserProfileId,
      executionHostIdentity,
      legacyExecutionHostIdentity:
        legacyBrowserNativeExecutionHostStorageIdentity(authorityRuntimeId)
    }),
    storageScope,
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    rendererWebContentsId: 11,
    proxyEndpoint: { host: '127.0.0.1', port: 43123 }
  })
  handle.release()
  return handle.partition
}

describe('WSL host browser route partition', () => {
  it('is the partition the host pages later use, across an orcad relaunch and re-pair', async () => {
    const seeded = bindWslHostBrowserRoutePartition(stableStorage(wslHost(1_000, 'a')), 'default')

    const afterRelaunch = await firstPagePartition(wslHost(2_000, 'b'), 'runtime-b')

    expect(afterRelaunch).toBe(seeded)
    expect(bindWslHostBrowserRoutePartition(stableStorage(wslHost(3_000, 'c')), 'default')).toBe(
      seeded
    )
  })

  it('keeps one partition per browser profile', () => {
    const storage = stableStorage(wslHost(1_000, 'a'))
    expect(bindWslHostBrowserRoutePartition(storage, 'default')).not.toBe(
      bindWslHostBrowserRoutePartition(storage, 'work')
    )
  })

  it('adopts the jar the host already had before W1 instead of starting another', () => {
    const environment = wslHost(1_000, 'a')
    const storageScope = deriveBrowserRoutePartitionStorageScope({
      orcaProfileId,
      environmentId: environment.id
    })
    const preW1 = deriveBrowserRoutePartition({
      orcaProfileId,
      browserProfileId: 'default',
      authorityConnectionIdentity: preW1AuthorityConnectionIdentity(
        orcaProfileId,
        environment,
        getPreferredPairedRuntimeConnection(environment)
      ),
      executionHostIdentity: browserAuthorityExecutionHostStorageIdentity(storageScope)
    })
    new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath }).set(
      preW1.partition,
      preW1.bindingFingerprint,
      storageScope
    )

    expect(bindWslHostBrowserRoutePartition(stableStorage(environment), 'default')).toBe(
      preW1.partition
    )
  })

  it('refuses a partition name another identity already owns', () => {
    const storage = stableStorage(wslHost(1_000, 'a'))
    const partition = bindWslHostBrowserRoutePartition(storage, 'default')
    const store = new BrowserRoutePartitionBindingStore({ filePath: bindings.filePath })
    store.remove([partition])
    store.set(partition, 'f'.repeat(64), storage.storageScope)

    expect(() => bindWslHostBrowserRoutePartition(storage, 'default')).toThrow(
      'browser_route_partition_binding_conflict'
    )
  })

  it('reports no stable partition for a WSL host without its distro registration id', () => {
    const environment = pairedRuntimeHostEnvironment({ kind: 'wsl', distroId: null })
    expect(wslHostBrowserRouteStorage(orcaProfileId, environment)).toEqual({
      kind: 'unavailable',
      reason: 'no-stable-partition'
    })
  })

  it.each<PairedRuntimeHostKind>(['manual', 'plain-ssh', 'managed-ssh'])(
    'never resolves a %s host, so its partitions stay untouched',
    (kind) => {
      expect(
        wslHostBrowserRouteStorage(orcaProfileId, pairedRuntimeHostEnvironment({ kind }))
      ).toEqual({ kind: 'unavailable', reason: 'destination-not-wsl-host' })
    }
  )
})
