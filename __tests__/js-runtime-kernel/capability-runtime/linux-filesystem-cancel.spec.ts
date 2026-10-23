import { expect, it } from 'vitest'
import {
  CapabilityRuntimeInvocationKernelV1,
  LinuxFilesystemCapabilityBridgeV1
} from '../../../src/capability-runtime/index.js'
import { creation, middleware, policyV2, provider } from './broker-fixtures.js'

it('aborting a closed Linux environment prevents deferred middleware from opening a Host file', async () => {
  let entered!: () => void
  let resume!: () => void
  const waiting = new Promise<void>(resolve => {
    resume = resolve
  })
  const ready = new Promise<void>(resolve => {
    entered = resolve
  })
  let io = 0
  const kernel = new CapabilityRuntimeInvocationKernelV1({
    admitted: creation({
      'host.fs': provider('host.fs', 'sync', {}, () => {
        io++
      })
    }, {
      schemaVersion: 1,
      registrations: [middleware('defer', async (_context, next) => {
        entered()
        await waiting
        return next()
      })]
    }, policyV2()),
    engine: 'embedded-v8',
    target: 'desktop',
    requestPrefix: 'source',
    networkProvider: 'host.network.mock'
  })
  const filesystem = new LinuxFilesystemCapabilityBridgeV1().bind((input, signal) =>
    kernel.invokeFromSource(input, signal)
  )
  const controller = new AbortController()
  const pending = filesystem.dispatch({
    environmentId: 'env-1',
    executableId: 'cat',
    linuxPid: 17,
    processId: 1,
    processResourceId: 'process-1',
    scope: 'processTree',
    operation: 'open',
    flags: 0,
    path: '/workspace/target',
    signal: controller.signal,
    policy: {
      access: 'sandboxed',
      mounts: [{ rootId: 'workspace', guestPath: '/workspace', rights: ['read'] }]
    } as never
  })
  try {
    await ready
    controller.abort('environment-closed')
    await expect(pending).rejects.toMatchObject({ errno: 4 })
    resume()
    await waiting
    await Promise.resolve()
    expect(io).toBe(0)
  } finally {
    resume()
    kernel.close()
  }
})
