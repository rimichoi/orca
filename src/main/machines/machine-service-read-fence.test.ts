import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { MachineService } from './machine-service'
import {
  KEY,
  inventory,
  machine,
  removeMachineServiceRoots,
  reply,
  setup,
  type Handler
} from './machine-service.test-fixture'

afterEach(removeMachineServiceRoots)

const SLEEPING = machine({ state: 'sleeping', access: undefined })

/** A provider answer the test releases, so a read can be made to finish after a mutation. */
function held(answer: Handler): { handler: Handler; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    handler: async (args) => {
      await gate
      return answer(args)
    },
    release
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('MachineService reads against lifecycle results', () => {
  it('keeps a sleep result over a list that began before the sleep finished', async () => {
    const staleList = held(inventory([machine()]))
    const { service } = await setup({
      list: [inventory([machine()]), staleList.handler],
      sleep: reply(SLEEPING)
    })
    await service.list(KEY)
    const listing = service.list(KEY, { force: true })
    await tick()
    await expect(service.sleep(KEY, 'sbx-1')).resolves.toMatchObject({ state: 'sleeping' })
    staleList.release()
    await listing
    expect(service.snapshots()[0]?.machines[0]?.state).toBe('sleeping')
  })

  it('keeps a machine a create made over a list that began before it existed', async () => {
    const staleList = held(inventory([]))
    const { service } = await setup({
      list: [inventory([]), staleList.handler],
      create: (args) => reply(machine({ creatingOperationId: args.operationId }))(args)
    })
    await service.list(KEY)
    const listing = service.list(KEY, { force: true })
    await tick()
    await service.create(KEY, { name: 'dev', lifetime: 'persistent' })
    staleList.release()
    await listing
    expect(service.snapshots()[0]?.machines).toEqual([
      expect.objectContaining({ id: 'sbx-1', state: 'running' })
    ])
  })

  it('keeps a wake result over a get that began before the wake finished', async () => {
    const staleGet = held(reply(SLEEPING))
    const { service } = await setup({
      list: inventory([SLEEPING]),
      get: staleGet.handler,
      wake: reply(machine())
    })
    await service.list(KEY)
    const reading = service.get(KEY, 'sbx-1')
    await tick()
    await service.wake(KEY, 'sbx-1')
    staleGet.release()
    await expect(reading).resolves.toMatchObject({ state: 'running' })
  })
})

describe('MachineService pairing credentials', () => {
  const code = (deviceToken: string) =>
    encodePairingOffer({
      v: 2,
      endpoint: 'wss://sandbox.example.com',
      deviceToken,
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })

  it('pairs again after a failed pairing instead of trusting the offered code', async () => {
    const orcaServer = machine({
      access: { kind: 'orca-server', pairingCode: code('first'), projectRoot: '/w' }
    })
    const { deps } = await setup({ list: inventory([orcaServer]), get: reply(orcaServer) })
    const add = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: 'unreachable', message: 'no answer' })
      .mockResolvedValueOnce({ ok: true, environment: { id: 'env-1' } })
    const service = new MachineService({ ...deps, pairing: { add, repair: vi.fn() } })
    await service.list(KEY)
    await expect(service.connect(KEY, 'sbx-1')).rejects.toThrow('no answer')
    expect(service.snapshots()[0]?.machines[0]?.pairingCodeSha256).toBeUndefined()
    await expect(service.connect(KEY, 'sbx-1')).resolves.toMatchObject({
      runtimeEnvironmentId: 'env-1'
    })
    expect(add).toHaveBeenCalledTimes(2)
    expect(service.snapshots()[0]?.machines[0]?.pairingCodeSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('repairs with a rotated code after pairing once', async () => {
    const first = machine({
      access: { kind: 'orca-server', pairingCode: code('first'), projectRoot: '/w' }
    })
    const rotated = machine({
      access: { kind: 'orca-server', pairingCode: code('rotated'), projectRoot: '/w' }
    })
    const { deps } = await setup({
      list: [inventory([first]), inventory([rotated])],
      get: [reply(first), reply(rotated)]
    })
    const repair = vi.fn(async () => ({ ok: true as const, environment: { id: 'env-1' } }))
    const service = new MachineService({
      ...deps,
      pairing: {
        add: vi.fn(async () => ({ ok: true as const, environment: { id: 'env-1' } })),
        repair
      }
    })
    await service.list(KEY)
    await service.connect(KEY, 'sbx-1')
    // A list that offers the rotated code must not make the next connect skip the repair.
    await service.list(KEY, { force: true })
    await service.connect(KEY, 'sbx-1')
    expect(repair).toHaveBeenCalledTimes(1)
  })
})
