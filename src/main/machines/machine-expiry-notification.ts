import type { MachineExpiryWarning } from '../../shared/machine-inventory'
import { translateMain } from '../i18n/main-i18n'

function uncommittedPhrase(count: number): string {
  return count === 1
    ? translateMain('machines.expiryWarning.uncommitted_one', '{{count}} uncommitted change', {
        count
      })
    : translateMain('machines.expiryWarning.uncommitted_other', '{{count}} uncommitted changes', {
        count
      })
}

function unpushedPhrase(count: number): string {
  return count === 1
    ? translateMain('machines.expiryWarning.unpushed_one', '{{count}} unpushed commit', { count })
    : translateMain('machines.expiryWarning.unpushed_other', '{{count}} unpushed commits', {
        count
      })
}

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
        'Orca couldn’t check for unsaved work on it.'
      )
    }
  }
  const parts = [
    ...(work.uncommitted > 0 ? [uncommittedPhrase(work.uncommitted)] : []),
    ...(work.unpushed > 0 ? [unpushedPhrase(work.unpushed)] : [])
  ]
  if (parts.length === 0) {
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
      '{{work}} on it will be lost unless you push first.',
      { work: parts.join(', ') }
    )
  }
}
