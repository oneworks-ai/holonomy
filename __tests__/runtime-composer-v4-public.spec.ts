import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ambient = [
  'Buffer',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'EventTarget',
  'fetch',
  'crypto'
] as const

describe('runtime composer V4 public and bare boundaries', () => {
  it('loads root and runtime built entries without ambient platform globals', () => {
    const root = new URL('../dist/index.js', import.meta.url).href
    const runtime = new URL('../dist/runtime/index.js', import.meta.url).href
    const script = `for (const key of ${
      JSON.stringify(ambient)
    }) Reflect.deleteProperty(globalThis, key); const root = await import(${
      JSON.stringify(root)
    }); const runtime = await import(${
      JSON.stringify(runtime)
    }); if (typeof root.createMobileRuntime !== 'function' || typeof runtime.createMobileRuntime !== 'function') process.exit(1)`
    expect(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script])).not.toThrow()
  })

  it('keeps public root/runtime declarations limited to runtime contracts', () => {
    const sourceRoot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const sourceRuntime = readFileSync(new URL('../src/runtime/index.ts', import.meta.url), 'utf8')
    const distRoot = readFileSync(new URL('../dist/index.d.ts', import.meta.url), 'utf8')
    const distRuntime = readFileSync(new URL('../dist/runtime/index.d.ts', import.meta.url), 'utf8')
    const privateNames = [
      'setRuntimeComposerFactoriesForTest',
      'getRuntimeComposerFactories',
      'snapshotRecord',
      'createLoaderGate',
      'disposeQuietly',
      'isRuntimeComposerError'
    ]
    for (let index = 0; index < privateNames.length; index += 1) {
      const name = privateNames[index]!
      expect(sourceRoot).not.toContain(name)
      expect(sourceRuntime).not.toContain(name)
      expect(distRoot).not.toContain(name)
      expect(distRuntime).not.toContain(name)
    }
    expect(`${sourceRoot}\n${sourceRuntime}`).toContain('./runtime/index.js')
    expect(distRoot).toContain('./runtime/index.js')
    expect(distRuntime).toContain('./runtime.js')
  })
})
