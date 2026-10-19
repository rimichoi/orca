import type { MachineExpiryWarning } from '../../shared/machine-inventory'
import { translateMain } from '../i18n/main-i18n'

/** The banner for a machine about to be deleted; unknown work is said, never left out. */
export function machineExpiryNotification(warning: MachineExpiryWarning): {
  title: string
  body: string
} {
  const time = new Date(warning.expiresAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
  const title = translateMain('machines.expiryWarning.title', '{{machine}} deletes at {{time}}', {
    machine: warning.name,
    time
  })
  const work = warning.workAtRisk
  if (!work) {
    return {
      title,
      body: translateMain(
        'machines.expiryWarning.unknownWork',
        'Orca couldn’t check unsaved work on it. Push anything you need before then.'
      )
    }
  }
  if (work.uncommitted === 0 && work.unpushed === 0) {
    return {
      title,
      body: translateMain(
        'machines.expiryWarning.noWork',
        'Everything on it is deleted with it. Orca found no uncommitted or unpushed work.'
      )
    }
  }
  return {
    title,
    body: translateMain(
      'machines.expiryWarning.work',
      '{{uncommitted}} uncommitted changes and {{unpushed}} unpushed commits on it will be lost unless you push first.',
      { uncommitted: work.uncommitted, unpushed: work.unpushed }
    )
  }
}
