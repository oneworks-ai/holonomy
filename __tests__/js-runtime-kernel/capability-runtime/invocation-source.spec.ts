import { describe, expect, it } from 'vitest'

import {
  CapabilityRuntimeInvocationKernelV1,
  trustedInvocationValueFromSnapshotV1
} from '../../../src/capability-runtime/index.js'
import type { HoloInvocationContextV1 } from '../../../src/capability-runtime/index.js'
import { creation, provider } from './broker-fixtures.js'

const result = (value: unknown) =>
  trustedInvocationValueFromSnapshotV1({
    direction: 'result',
    root: {
      entries: Object.entries(value as Record<string, unknown>).map(([key, item]) => ({
        key,
        value: { kind: 'scalar', value: item }
      })),
      kind: 'object'
    },
    schemaVersion: 1
  }, 'result')

const source = Object.freeze({
  environmentId: '1:runtime',
  environmentScope: 'runtime' as const,
  executableId: 'curl',
  kind: 'linuxProcess' as const,
  linuxPid: 41,
  processResourceId: 'process-1',
  syntheticProcessId: 7
})

describe('trusted capability invocation source', () => {
  it('exposes Linux process attribution to matching Host middleware and Provider only', async () => {
    const observed: HoloInvocationContextV1[] = []
    const fs = provider('host.fs', 'sync', null, (context, authority) => {
      observed.push(context)
      return authority.complete(result({
        birthtimeMs: 0,
        ctimeMs: 0,
        kind: 'file',
        mtimeMs: 0,
        size: 3
      }))
    })
    let matched = 0
    let other = 0
    const admitted = creation({ 'host.fs': fs }, {
      registrations: [{
        execution: 'async',
        layer: 'application',
        matcher: { source: { environmentScope: 'runtime', executableId: 'curl', kind: 'linuxProcess' } },
        middleware: async (_context, next) => {
          matched += 1
          return await next()
        },
        registrationId: 'source-match'
      }, {
        execution: 'async',
        layer: 'application',
        matcher: { source: { executableId: 'git' } },
        middleware: async (_context, next) => {
          other += 1
          return await next()
        },
        registrationId: 'source-other'
      }],
      schemaVersion: 1
    })
    const kernel = new CapabilityRuntimeInvocationKernelV1({
      admitted,
      engine: 'node-vm',
      networkProvider: 'host.network',
      requestPrefix: 'source-test',
      target: 'node'
    })

    await expect(kernel.invokeFromSource({
      arguments: { path: 'holo-fs://workspace/demo.txt' },
      member: 'stat',
      mode: 'promise',
      module: 'node:fs/promises',
      path: 'holo-fs://workspace/demo.txt',
      source
    })).resolves.toMatchObject({ kind: 'file', size: 3 })
    expect({ matched, other }).toEqual({ matched: 1, other: 0 })
    expect(observed[0]?.source).toEqual(source)

    const guest = JSON.parse(
      await kernel.invoke(JSON.stringify({
        arguments: { path: 'holo-fs://workspace/demo.txt' },
        member: 'stat',
        mode: 'promise',
        module: 'node:fs/promises',
        path: 'holo-fs://workspace/demo.txt',
        source
      }))
    )
    expect(guest).toMatchObject({ error: { code: 'EINVAL' }, ok: false })

    kernel.close(true)
    await expect(kernel.invokeFromSource({
      arguments: { path: 'holo-fs://workspace/demo.txt' },
      member: 'stat',
      mode: 'promise',
      module: 'node:fs/promises',
      path: 'holo-fs://workspace/demo.txt',
      source
    })).rejects.toMatchObject({ code: 'runtime.generation_stale' })
  })
})
