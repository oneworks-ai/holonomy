import { describe, expect, it } from 'vitest'

import type {
  ProcessBackendEnvironmentOpenRequestV1,
  ProcessBackendEnvironmentV1
} from '@holonomyjs/capability-process'
import { HoloUvEnvironmentRuntimeV1 } from '@holonomyjs/holouv'

type Configuration = Readonly<{ image: string }>
type Executable = Readonly<{ path: string }>

const request = (scope: 'processTree' | 'runtime', generation = 7) => ({
  configuration: Object.freeze({ image: 'fixture' }),
  executables: Object.freeze([Object.freeze({
    executable: Object.freeze({ path: '/bin/tool' }),
    executableId: 'tool',
    fixedArgs: Object.freeze([]),
    shell: false
  })]),
  generation,
  policy: Object.freeze({ access: 'sandboxed' }),
  scope
})

const fixture = () => {
  const closed: [string, string][] = []
  const opened: ProcessBackendEnvironmentOpenRequestV1<Configuration, Executable>[] = []
  const factory = {
    async open(input: ProcessBackendEnvironmentOpenRequestV1<Configuration, Executable>) {
      opened.push(input)
      return {
        async close(reason) {
          closed.push([input.environmentId, reason])
        },
        async spawn() {
          throw new Error('unused')
        }
      } satisfies ProcessBackendEnvironmentV1<Executable>
    }
  }
  return { closed, opened, runtime: new HoloUvEnvironmentRuntimeV1(factory) }
}

describe('holouv environment runtime', () => {
  it('reuses runtime scope and closes processTree scope when its lease completes', async () => {
    const value = fixture()
    const firstRuntime = value.runtime.acquire(request('runtime'), 'process-1')
    const secondRuntime = value.runtime.acquire(request('runtime'), 'process-2')
    const firstTree = value.runtime.acquire(request('processTree'), 'process-1')
    const secondTree = value.runtime.acquire(request('processTree'), 'process-2')

    expect(firstRuntime.environment).toBe(secondRuntime.environment)
    expect(value.runtime.activeEnvironmentIds()).toEqual([
      '7:processTree:process-1',
      '7:processTree:process-2',
      '7:runtime'
    ])
    await Promise.all([firstTree.release(), secondTree.release()])
    expect(value.closed).toEqual([
      ['7:processTree:process-1', 'process-complete'],
      ['7:processTree:process-2', 'process-complete']
    ])
    await value.runtime.closeGeneration(7)
    expect(value.closed).toContainEqual(['7:runtime', 'generation-stale'])
    expect(value.runtime.activeEnvironmentIds()).toEqual([])
  })

  it('fences acquisition as soon as generation close begins', async () => {
    const value = fixture()
    value.runtime.acquire(request('runtime'), 'process-1')
    await value.runtime.closeGeneration(7)

    expect(() => value.runtime.acquire(request('runtime'), 'process-2')).toThrow(TypeError)
    expect(value.opened[0]?.signal.aborted).toBe(true)
    expect(value.opened[0]?.signal.reason).toBe('generation-stale')
  })

  it('removes a failed open without closing another generation', async () => {
    let attempts = 0
    const runtime = new HoloUvEnvironmentRuntimeV1<Configuration, Executable>({
      async open() {
        attempts += 1
        if (attempts === 1) throw new Error('fixture open failure')
        return {
          async close() {},
          async spawn() {
            throw new Error('unused')
          }
        }
      }
    })
    await expect(runtime.acquire(request('runtime'), 'process-1').environment).rejects.toThrow('fixture open failure')
    await expect(runtime.acquire(request('runtime'), 'process-2').environment).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  it('shares one in-flight close and waits for every environment', async () => {
    let finishClose: (() => void) | undefined
    let closeCalls = 0
    const runtime = new HoloUvEnvironmentRuntimeV1<Configuration, Executable>({
      async open() {
        return {
          close() {
            closeCalls += 1
            return new Promise<void>(resolve => {
              finishClose = resolve
            })
          },
          async spawn() {
            throw new Error('unused')
          }
        }
      }
    })
    await runtime.acquire(request('runtime'), 'process-1').environment

    const first = runtime.close()
    const second = runtime.close()
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()

    expect(first).toBe(second)
    expect(closeCalls).toBe(1)
    expect(secondSettled).toBe(false)
    finishClose?.()
    await Promise.all([first, second])
    expect(secondSettled).toBe(true)
  })
})
