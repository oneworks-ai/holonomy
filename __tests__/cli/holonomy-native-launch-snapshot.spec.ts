import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseHolonomyArgs } from '../../tools/holonomy-cli-options.mjs'
import { prepareHolonomyLaunchSnapshot } from '../../tools/holonomy-launch-snapshot.mjs'
import { runHolonomyRuntimeCommand } from '../../tools/holonomy-managed-command.mjs'
import { getHolonomyNativeSourceContext } from '../../tools/holonomy-native-launch-snapshot.mjs'
import { createNativeSourceReader } from '../../tools/holonomy-native-source-reader.mjs'
import type { NativeSourceReader } from '../../tools/holonomy-native-source-reader.mjs'

const executable = process.env.HOLONOMY_NATIVE_SOURCE_HELPER

describe('native managed source preflight', () => {
  it.skipIf(executable == null)(
    'keeps the original entry and exact package metadata under one reader lease',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'holo-native-preflight-'))
      const home = mkdtempSync(join(tmpdir(), 'holo-native-service-home-'))
      try {
        const packageRoot = join(root, 'node_modules', '@fixture', 'value')
        mkdirSync(packageRoot, { recursive: true })
        writeFileSync(join(root, 'index.mjs'), "\uFEFFimport value from '@fixture/value'; console.log(value)")
        writeFileSync(
          join(packageRoot, 'package.json'),
          JSON.stringify({
            exports: { '.': { __oneworks__: './source.ts', default: './index.mjs' } },
            name: '@fixture/value',
            type: 'module'
          })
        )
        writeFileSync(join(packageRoot, 'index.mjs'), 'export default 42')
        writeFileSync(join(packageRoot, 'source.ts'), 'export default 999')
        writeFileSync(join(root, 'permission.mjs'), 'export default () => undefined')
        writeFileSync(
          join(root, 'holo.config.json'),
          JSON.stringify({
            plugins: [{ id: 'permission', use: './permission.mjs' }]
          })
        )
        writeFileSync(
          join(home, 'sandbox.json'),
          `\uFEFF${JSON.stringify({ schemaVersion: 1, filesystem: { access: 'none' } })}`
        )
        writeFileSync(join(root, 'capability.json'), JSON.stringify({ schemaVersion: 1 }))
        writeFileSync(join(root, 'rules.json'), JSON.stringify({ mode: 'passthrough', rules: [] }))
        const parsed = parseHolonomyArgs([
          'run',
          '--target',
          'native',
          '--config',
          join(root, 'holo.config.json'),
          '--sandbox',
          join(home, 'sandbox.json'),
          '--capability-runtime',
          join(root, 'capability.json'),
          '--network-rules',
          join(root, 'rules.json'),
          join(root, 'index.mjs')
        ])
        const captured: string[] = []
        const snapshot = await prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
          cwd: root,
          home,
          nativeSourceExecutablePath: executable,
          randomUUID: () => 'fixed',
          createNativeSourceReader: async options => {
            const reader = await createNativeSourceReader(options)
            const capture = reader.capturePrivate.bind(reader)
            reader.capturePrivate = async file => {
              captured.push(file)
              return capture(file)
            }
            return reader
          }
        })
        const context = getHolonomyNativeSourceContext(snapshot)
        try {
          expect(snapshot.entryUrl).toBe('app://workspace/index.mjs')
          expect(captured[0]).toBe(executable)
          expect(snapshot.launch).toMatchObject({
            argv: ['app://workspace/index.mjs'],
            command: 'run',
            entryUrl: 'app://workspace/index.mjs'
          })
          expect(snapshot.launch).not.toHaveProperty('workspaceRoot')
          const urls = (snapshot.launch.modules as readonly { url: string }[]).map(row => row.url)
          const entrySource = (snapshot.launch.modules as readonly { source: string; url: string }[])
            .find(row => row.url === 'app://workspace/index.mjs')?.source
          expect(entrySource?.startsWith('\uFEFF')).toBe(true)
          expect(urls).toContain('app://workspace/index.mjs')
          expect(urls).toContain('app://workspace/node_modules/@fixture/value/package.json')
          expect(urls).toContain('app://workspace/node_modules/@fixture/value/index.mjs')
          expect(urls).not.toContain('app://workspace/node_modules/@fixture/value/source.ts')
          expect(urls).not.toContain('app://workspace/permission.mjs')
          expect(snapshot.runtimePlugins).toHaveLength(1)
          expect(context).toBeDefined()
        } finally {
          await context?.reader.close()
        }
      } finally {
        rmSync(home, { recursive: true, force: true })
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(executable == null)(
    'closes the Native reader after a detached admission and an admission failure',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'holo-native-lease-'))
      try {
        const home = join(root, 'service-home')
        mkdirSync(home)
        writeFileSync(join(root, 'index.mjs'), 'console.log(1)')
        const parsed = parseHolonomyArgs(['run', '--target', 'native', '--detach', join(root, 'index.mjs')])
        const closes = vi.fn()
        const dependencies = {
          cwd: root,
          home,
          nativeSourceExecutablePath: executable,
          createNativeSourceReader: async (options: Parameters<typeof createNativeSourceReader>[0]) => {
            const reader = await createNativeSourceReader(options)
            const close = reader.close.bind(reader)
            reader.close = async () => {
              closes()
              await close()
            }
            return reader
          },
          createClient: () => ({
            async call() {
              return [{ id: 'native:local', state: 'online' }]
            },
            async launchProcess() {
              return { value: { process: { id: 'p', generation: 1, state: 'starting' } } }
            }
          }),
          ensureService: async () => undefined
        }
        const io = { stderr: { write: () => undefined }, stdout: { write: () => undefined } }
        expect(await runHolonomyRuntimeCommand(parsed, io, dependencies)).toBe(0)
        expect(closes).toHaveBeenCalledTimes(1)
        dependencies.createClient = () => ({
          async call() {
            return [{ id: 'native:local', state: 'online' }]
          },
          async launchProcess() {
            throw new Error('admission failed')
          }
        })
        await expect(runHolonomyRuntimeCommand(parsed, io, dependencies)).rejects.toThrow('admission failed')
        expect(closes).toHaveBeenCalledTimes(2)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(executable == null)('rejects Guest import of the original private plugin file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-native-private-import-'))
    try {
      const home = join(root, 'service-home')
      mkdirSync(home)
      writeFileSync(join(root, 'index.mjs'), "import './permission.mjs'")
      writeFileSync(join(root, 'permission.mjs'), 'export default () => undefined')
      writeFileSync(
        join(root, 'holo.config.json'),
        JSON.stringify({
          plugins: [{ id: 'permission', use: './permission.mjs' }]
        })
      )
      const parsed = parseHolonomyArgs([
        'run',
        '--target',
        'native',
        '--config',
        join(root, 'holo.config.json'),
        join(root, 'index.mjs')
      ])
      await expect(prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
        cwd: root,
        home,
        nativeSourceExecutablePath: executable
      })).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(executable == null)('retains canonical query identities for one physical source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-native-query-import-'))
    try {
      const home = join(root, 'service-home')
      mkdirSync(home)
      writeFileSync(join(root, 'index.mjs'), "import './dep.mjs?mode=one'; import './dep.mjs?mode=two'")
      writeFileSync(join(root, 'dep.mjs'), 'export const value = 1')
      const parsed = parseHolonomyArgs(['run', '--target', 'native', join(root, 'index.mjs')])
      const snapshot = await prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
        cwd: root,
        home,
        nativeSourceExecutablePath: executable
      })
      try {
        const rows = snapshot.launch.modules as readonly { source: string; url: string }[]
        const queried = rows.filter(row => row.url.startsWith('app://workspace/dep.mjs?'))
        expect(queried.map(row => row.url)).toEqual([
          'app://workspace/dep.mjs?mode=one',
          'app://workspace/dep.mjs?mode=two'
        ])
        expect(queried[0]?.source).toBe(queried[1]?.source)
      } finally {
        await getHolonomyNativeSourceContext(snapshot)?.reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(executable == null)(
    'classifies nested Service diagnostic modules and dependency aliases before Guest collection',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'holo-native-private-observer-'))
      const home = join(root, 'service-home')
      try {
        mkdirSync(home, { mode: 0o700 })
        writeFileSync(join(home, 'private.mjs'), "export const marker = 'PRIVATE_OBSERVER_DEPENDENCY'")
        writeFileSync(
          join(home, 'profile.mjs'),
          "import { marker } from './private.mjs'; export default (event, config, sink) => { if (marker) sink.publish() }"
        )
        writeFileSync(
          join(home, 'native-observer-profiles.json'),
          JSON.stringify({
            profiles: {
              monitor: {
                registration: { acceptHighCost: true, events: ['script.compiled'] },
                use: './profile.mjs'
              }
            },
            schemaVersion: 1
          }),
          { mode: 0o600 }
        )
        linkSync(join(home, 'profile.mjs'), join(root, 'profile-alias.mjs'))
        linkSync(join(home, 'private.mjs'), join(root, 'dependency-alias.mjs'))
        const parsed = parseHolonomyArgs(['run', '--target', 'native', join(root, 'index.mjs')])
        for (
          const specifier of [
            './service-home/profile.mjs',
            './service-home/private.mjs',
            './profile-alias.mjs',
            './dependency-alias.mjs'
          ]
        ) {
          writeFileSync(join(root, 'index.mjs'), `import ${JSON.stringify(specifier)}`)
          await expect(prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
            cwd: root,
            home,
            nativeSourceExecutablePath: executable
          })).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED' })
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(executable == null)('uses one wrapper only for multiple Native test entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-native-multi-test-'))
    try {
      const home = join(root, 'service-home')
      mkdirSync(home)
      writeFileSync(join(root, 'first.test.mjs'), "import test from 'node:test'; test('first', () => {})")
      writeFileSync(join(root, 'second.test.mjs'), "import test from 'node:test'; test('second', () => {})")
      const parsed = parseHolonomyArgs([
        'test',
        '--target',
        'native',
        join(root, 'first.test.mjs'),
        join(root, 'second.test.mjs')
      ])
      const snapshot = await prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
        cwd: root,
        home,
        nativeSourceExecutablePath: executable,
        randomUUID: () => 'fixed'
      })
      try {
        expect(snapshot.entryUrl).toBe('app://workspace/test-fixed.mjs')
        const urls = (snapshot.launch.modules as readonly { url: string }[]).map(row => row.url)
        expect(urls).toEqual([
          'app://workspace/first.test.mjs',
          'app://workspace/second.test.mjs',
          'app://workspace/test-fixed.mjs'
        ])
      } finally {
        await getHolonomyNativeSourceContext(snapshot)?.reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(executable == null)('collects CommonJS require conditions for the actual entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-native-cjs-entry-'))
    try {
      const home = join(root, 'service-home')
      const packageRoot = join(root, 'node_modules', '@fixture', 'value')
      mkdirSync(home)
      mkdirSync(packageRoot, { recursive: true })
      writeFileSync(join(root, 'index.cjs'), "const value = require('@fixture/value'); console.log(value)")
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          exports: { '.': { __oneworks__: './source.ts', require: './index.cjs', default: './index.mjs' } },
          name: '@fixture/value'
        })
      )
      writeFileSync(join(packageRoot, 'index.cjs'), 'module.exports = 42')
      writeFileSync(join(packageRoot, 'index.mjs'), 'export default 43')
      writeFileSync(join(packageRoot, 'source.ts'), 'export default 44')
      const parsed = parseHolonomyArgs(['run', '--target', 'native', join(root, 'index.cjs')])
      const snapshot = await prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
        cwd: root,
        home,
        nativeSourceExecutablePath: executable
      })
      try {
        expect(snapshot.entryUrl).toBe('app://workspace/index.cjs')
        expect(snapshot.launch.argv).toEqual(['app://workspace/index.cjs'])
        const urls = (snapshot.launch.modules as readonly { url: string }[]).map(row => row.url)
        expect(urls).toContain('app://workspace/node_modules/@fixture/value/package.json')
        expect(urls).toContain('app://workspace/node_modules/@fixture/value/index.cjs')
        expect(urls).not.toContain('app://workspace/node_modules/@fixture/value/index.mjs')
        expect(urls).not.toContain('app://workspace/node_modules/@fixture/value/source.ts')
      } finally {
        await getHolonomyNativeSourceContext(snapshot)?.reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(executable == null)('fails closed when the executable cannot be captured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-native-binary-capture-'))
    try {
      const home = join(root, 'service-home')
      mkdirSync(home)
      writeFileSync(join(root, 'index.mjs'), 'export default 1')
      const parsed = parseHolonomyArgs(['run', '--target', 'native', join(root, 'index.mjs')])
      for (const mode of ['missing', 'rejected']) {
        const captured: string[] = []
        const closed = vi.fn()
        const reader = {
          async capturePrivate(file: string) {
            captured.push(file)
            if (mode === 'rejected') throw Object.assign(new Error('source rejected'), { code: 'source_rejected' })
            return null
          },
          async close() {
            closed()
          }
        } as unknown as NativeSourceReader
        const preparation = prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
          cwd: root,
          home,
          nativeSourceExecutablePath: executable,
          createNativeSourceReader: async () => reader
        })
        if (mode === 'rejected') await expect(preparation).rejects.toMatchObject({ code: 'source_rejected' })
        else await expect(preparation).rejects.toThrow('Native source reader executable is unavailable')
        expect(captured).toEqual([executable])
        expect(closed).toHaveBeenCalledOnce()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
