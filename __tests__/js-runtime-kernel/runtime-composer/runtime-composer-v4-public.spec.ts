import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as holonomy from '../../../src/index.js'

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
    const root = new URL('../../../dist/index.js', import.meta.url).href
    const runtime = new URL('../../../dist/runtime/index.js', import.meta.url).href
    const script = `for (const key of ${
      JSON.stringify(ambient)
    }) Reflect.deleteProperty(globalThis, key); const root = await import(${
      JSON.stringify(root)
    }); const runtime = await import(${
      JSON.stringify(runtime)
    }); if (typeof root.createHolonomyRuntime !== 'function' || typeof runtime.createHolonomyRuntime !== 'function') process.exit(1)`
    expect(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script])).not.toThrow()
  })

  it('keeps public root/runtime declarations limited to runtime contracts', () => {
    const sourceRoot = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8')
    const sourceRuntime = readFileSync(new URL('../../../src/runtime/index.ts', import.meta.url), 'utf8')
    const distRoot = readFileSync(new URL('../../../dist/index.d.ts', import.meta.url), 'utf8')
    const distRuntime = readFileSync(new URL('../../../dist/runtime/index.d.ts', import.meta.url), 'utf8')
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

  it('exposes one Holonomy brand across package, runtime, loader, errors and virtual paths', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>
    const declarations = [
      readFileSync(new URL('../../../dist/index.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/event-loop/errors.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/http-server/errors.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/module-loader/errors.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/module-loader/index.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/node-fs/facade.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/node-fs/index.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/runtime/index.d.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../dist/streams/errors.d.ts', import.meta.url), 'utf8')
    ].join('\n')

    expect(packageJson.name).toBe('@oneworks/holonomy')
    expect(packageJson.license).toBe('MIT')
    expect(holonomy.FS_VIRTUAL_SCHEME).toBe('holonomy-fs')
    expect(typeof holonomy.createHolonomyRuntime).toBe('function')
    expect(typeof holonomy.HolonomyModuleLoader).toBe('function')
    expect(typeof holonomy.HolonomyRuntimeError).toBe('function')
    expect('createMobileRuntime' in holonomy).toBe(false)
    expect('MobileModuleLoader' in holonomy).toBe(false)
    expect('MobileRuntimeError' in holonomy).toBe(false)
    expect('MobileNodeFsFacade' in holonomy).toBe(false)
    expect(existsSync(new URL('../../../dist/module-loader/mobile-module-loader.d.ts', import.meta.url))).toBe(false)

    for (
      const legacy of [
        '@oneworks/mobile-runtime',
        'ERR_MOBILE_',
        'MobileFs',
        'MobileModuleLoader',
        'MobileNodeFsFacade',
        'MobileRuntime',
        'mobile-fs://'
      ]
    ) expect(declarations).not.toContain(legacy)
  })
})
