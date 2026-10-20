import { describe, expect, it } from 'vitest'
import {
  getMachineDisplayState,
  getMachineDisplayStateLabel,
  machineNeedsWake
} from './machine-display-state'

describe('machine display state', () => {
  it('shows a sleep still in progress as Sleeping… and lets opening it wake the machine', () => {
    expect(getMachineDisplayState('stopping')).toBe('stopping')
    expect(getMachineDisplayStateLabel('stopping')).toBe('Sleeping…')
    expect(machineNeedsWake('stopping')).toBe(true)
    expect(machineNeedsWake('running')).toBe(false)
  })
})
