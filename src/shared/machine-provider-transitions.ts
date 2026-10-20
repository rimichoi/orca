import type { MachineProviderVerb } from './machine-provider-command'
import type { ProviderMachineState } from './machine-provider-protocol'

const CONFIRMED_STATES: Partial<Record<MachineProviderVerb, readonly ProviderMachineState[]>> = {
  create: ['creating', 'running'],
  wake: ['running', 'waking'],
  sleep: ['sleeping', 'stopping'],
  archive: ['archived', 'stopping']
}

/** Lifecycle verbs must report the state they moved to; anything else is unconfirmed. */
export function isConfirmedMachineTransition(
  verb: MachineProviderVerb,
  state: ProviderMachineState
): boolean {
  if (verb === 'delete') {
    return state !== 'running' && state !== 'waking'
  }
  const confirmed = CONFIRMED_STATES[verb]
  return confirmed ? confirmed.includes(state) : true
}
