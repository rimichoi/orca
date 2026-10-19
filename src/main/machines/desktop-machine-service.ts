import { BrowserWindow } from 'electron'
import { machineProviderKey, type MachineRecord } from '../../shared/machine-inventory'
import { getSshConnectionStore } from '../ipc/ssh/ssh'
import {
  disconnectRegisteredSshTarget,
  removeRegisteredSshTarget
} from '../ipc/ssh/ssh-session-teardown'
import {
  verifyAndAddRuntimeEnvironmentFromPairingCode,
  verifyAndRepairRuntimeEnvironmentFromPairingCode
} from '../ipc/runtime-environments/runtime-environment-pairing-verification'
import type { PluginService } from '../plugins/plugin-service'
import { connectRegisteredSshTarget } from '../ssh/targets/ssh-target-registry'
import type { MachineSshTargets } from './machine-connect'
import { MachineService, type MachineProviderEntry } from './machine-service'
import { MachineExpiryWarnings } from './machine-expiry-warnings'
import { machineExpiryNotification } from './machine-expiry-notification'
import { readMachineWorkAtRisk } from './machine-work-at-risk'
import { dispatchDesktopNotification } from '../ipc/notifications'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'

let registered: { service: MachineService; isEnabled: () => boolean } | null = null

/** The host's MachineService for runtime RPC; null where none is registered or the flag is off. */
export function getMachineService(): MachineService | null {
  return registered?.isEnabled() ? registered.service : null
}

function requireSshStore(): NonNullable<ReturnType<typeof getSshConnectionStore>> {
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  return store
}

const sshTargets: MachineSshTargets = {
  getTarget: (id) => getSshConnectionStore()?.getTarget(id),
  ensureTarget: (id, fields) => requireSshStore().ensureMachineOwnedTarget(id, fields),
  updateTarget: (id, updates) => requireSshStore().updateTarget(id, updates),
  connect: (id) => connectRegisteredSshTarget(id),
  disconnect: (id) => disconnectRegisteredSshTarget(id)
}

function listPluginMachineProviders(pluginService?: PluginService): MachineProviderEntry[] {
  return (pluginService?.contentPacks.vmRecipes.listMachineProviders() ?? []).map(
    ({ pluginKey, pluginRootDir, provider }) => ({
      providerKey: machineProviderKey(pluginKey, provider.id),
      name: provider.name,
      source: { command: provider.command, pluginRootDir }
    })
  )
}

function broadcast(
  channel: 'machines:changed' | 'machines:progress' | 'machines:expiryWarning',
  payload: unknown
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(channel, payload)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

/** Providers run in this process, with this desktop's ssh config and credentials. */
export function createDesktopMachineService(options: {
  userDataPath: string
  pluginService?: PluginService
  isEnabled: () => boolean
  isHostReferenced: (hostId: string) => boolean
  retireEnvironment: (environmentId: string) => void
}): { service: MachineService; expiryWarnings: MachineExpiryWarnings } {
  const { userDataPath, pluginService, isEnabled, isHostReferenced, retireEnvironment } = options
  let expiryWarnings: MachineExpiryWarnings | null = null
  const service = new MachineService({
    userDataPath,
    isHostReferenced,
    retireEnvironment,
    listProviders: () => listPluginMachineProviders(pluginService),
    onChanged: (snapshot) => {
      broadcast('machines:changed', snapshot)
      expiryWarnings?.reschedule()
    },
    onProgress: (event) => broadcast('machines:progress', event),
    sshTargets,
    removeSshTarget: removeRegisteredSshTarget,
    pairing: {
      add: ({ name, pairingCode }) =>
        verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, {
          name,
          pairingCode,
          allowLoopback: false
        }),
      repair: (args) => verifyAndRepairRuntimeEnvironmentFromPairingCode(userDataPath, args)
    }
  })
  expiryWarnings = new MachineExpiryWarnings({
    snapshots: () => (isEnabled() ? service.snapshots() : []),
    hasWarned: service.expiryWarningLog.has,
    markWarned: service.expiryWarningLog.mark,
    readWorkAtRisk: (machine) => {
      // A machine's worktrees live in its Orca server's catalog, not on this desktop.
      const environmentId = machine.managedEnvironmentId ?? machine.runtimeEnvironmentId
      return environmentId
        ? readMachineWorkAtRisk((method, params, timeoutMs) =>
            callRuntimeEnvironment(userDataPath, environmentId, method, params, timeoutMs)
          )
        : Promise.resolve(null)
    },
    warn: (warning, machine, key) => {
      const hostId = machineHostId(machine)
      void dispatchDesktopNotification({
        source: 'machine-expiry',
        notificationId: key,
        attentionKey: key,
        // Per-host mutes apply: the host its worktrees run on.
        ...(hostId ? { notificationSourceId: hostId } : {}),
        machineExpiry: machineExpiryNotification(warning)
      })
      broadcast('machines:expiryWarning', warning)
    }
  })
  expiryWarnings.reschedule()
  registered = { service, isEnabled }
  return { service, expiryWarnings }
}

/** The execution host a per-host notification mute names for this machine's worktrees. */
function machineHostId(machine: MachineRecord): ExecutionHostId | undefined {
  const environmentId = machine.managedEnvironmentId ?? machine.runtimeEnvironmentId
  return environmentId
    ? toRuntimeExecutionHostId(environmentId)
    : machine.sshTargetId
      ? toSshExecutionHostId(machine.sshTargetId)
      : undefined
}
