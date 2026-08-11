import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import * as packageRoot from '../../../src/index.js'
import { STREAM_CAPABILITY_MATRIX } from '../../../src/streams/capabilities.js'
import * as streamsPublic from '../../../src/streams/index.js'
import { finished, finishedPromise, pipeline, pipelinePromise } from '../../../src/streams/node-pipeline.js'
import { createStreamSyntheticModuleBindings, createStreamSyntheticModules } from '../../../src/streams/registry.js'

describe('stream capability matrix and synthetic modules', () => {
  it('declares exact supported, partial and unsupported boundaries', () => {
    expect(STREAM_CAPABILITY_MATRIX.version).toBe(1)
    expect(STREAM_CAPABILITY_MATRIX.modules['web:streams'].features).toMatchObject({
      'ReadableStream.getReader': { status: 'supported' },
      'ReadableStreamDefaultReader.constructor': { status: 'supported' },
      'ReadableStream.tee': { status: 'unsupported' },
      'TransformStream.backpressureTiming': { status: 'partial' }
    })
    expect(STREAM_CAPABILITY_MATRIX.modules['node:stream'].features).toMatchObject({
      'Readable.fromWeb': { status: 'supported' },
      'Readable.toWeb': { status: 'unsupported' },
      'autoDestroyTiming': { status: 'partial' },
      'finished.destroyErrorIdentity': { status: 'supported' },
      'finished.prematureCloseErrorIdentity': { status: 'partial' },
      'Readable.pipe.runtimeDestinationErrorOrdering': { status: 'supported' },
      'Readable.pipe.foreignDestinationErrorOrdering': { status: 'partial' },
      objectMode: { status: 'unsupported' }
    })
    expect(STREAM_CAPABILITY_MATRIX.modules['node:stream'].constraints).toContain(
      'finished preserves an original destroy error by identity. Repeated no-error premature observations reuse one ERR_HOLONOMY_STREAM_PREMATURE_CLOSE object; Node uses ERR_STREAM_PREMATURE_CLOSE and does not promise that object identity.'
    )
    expect(STREAM_CAPABILITY_MATRIX.modules['node:stream'].constraints).toContain(
      'Pipe cleanup runs before user error listeners for runtime Stream destinations. Foreign writable destinations use append-listener fallback, so a throwing pre-existing error listener can prevent pipe cleanup.'
    )
    expect(STREAM_CAPABILITY_MATRIX.modules['node:stream'].features).toMatchObject({
      'pipeline.callback': { status: 'supported' },
      'finished.callback': { status: 'supported' },
      'finished.cleanup': { status: 'supported' },
      'Transform.readableBackpressure': { status: 'supported' }
    })
    for (const capability of Object.values(STREAM_CAPABILITY_MATRIX.modules)) {
      expect(Object.isFrozen(capability)).toBe(true)
      expect(Object.isFrozen(capability.features)).toBe(true)
      expect(capability.constraints.length).toBeGreaterThan(0)
    }
  })

  it('creates frozen namespaces and derives loader export names from them', () => {
    const modules = createStreamSyntheticModules()
    expect(Object.keys(modules).sort()).toEqual([
      'node:stream',
      'node:stream/promises',
      'node:stream/web'
    ])
    expect(Object.isFrozen(modules)).toBe(true)
    for (const namespace of Object.values(modules)) {
      expect(Object.isFrozen(namespace)).toBe(true)
    }

    const bindings = createStreamSyntheticModuleBindings()
    expect(modules['node:stream'].pipeline).toBe(pipeline)
    expect(modules['node:stream/promises'].pipeline).toBe(pipelinePromise)
    expect(modules['node:stream'].pipeline).not.toBe(modules['node:stream/promises'].pipeline)
    expect(modules['node:stream'].finished).toBe(finished)
    expect(modules['node:stream/promises'].finished).toBe(finishedPromise)
    expect(modules['node:stream'].finished).not.toBe(modules['node:stream/promises'].finished)
    expect(Object.isFrozen(bindings)).toBe(true)
    for (const [specifier, binding] of Object.entries(bindings)) {
      expect(Object.keys(binding.namespace)).toStrictEqual(
        Object.keys(modules[specifier as keyof typeof modules])
      )
      expect(binding.descriptor.exportNames).toStrictEqual(
        Object.keys(binding.namespace)
      )
      expect(Object.isFrozen(binding.descriptor.exportNames)).toBe(true)
    }
  })

  it('keeps pipe pre-error hooks out of public namespaces and declarations', () => {
    expect(packageRoot).not.toHaveProperty('registerBeforeErrorHook')
    expect(streamsPublic).not.toHaveProperty('registerBeforeErrorHook')
    const modules = createStreamSyntheticModules()
    for (const namespace of Object.values(modules)) {
      expect(namespace).not.toHaveProperty('registerBeforeErrorHook')
    }
    for (
      const declaration of [
        '../../../dist/index.d.ts',
        '../../../dist/streams/index.d.ts',
        '../../../dist/streams/node-streams.d.ts'
      ]
    ) {
      const contents = readFileSync(new URL(declaration, import.meta.url), 'utf8')
      expect(contents).not.toContain('registerBeforeErrorHook')
    }
  })
})
