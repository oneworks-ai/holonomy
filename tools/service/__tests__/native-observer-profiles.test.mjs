import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, vi } from 'vitest'

import { createNativeSourceReader } from '../../holonomy-native-source-reader.mjs'
import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import {
  normalizeServiceNativeObserverProfilesV1,
  readServiceNativeObserverProfilesV1
} from '../native-observer-profiles.mjs'
import { readBoundedRegularFile } from '../secure-file-read.mjs'
import { createHolonomyService } from '../server.mjs'

const createdRuntimeManager = vi.hoisted(() => ({ options: undefined }))
vi.mock('../capability-runtime-manager.mjs', async importOriginal => {
  const original = await importOriginal()
  return {
    ...original,
    createServiceCapabilityRuntimeManagerV1: options => {
      createdRuntimeManager.options = options
      return original.createServiceCapabilityRuntimeManagerV1(options)
    }
  }
})

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
const hasBinary = existsSync(binary)
const source = 'export default (event, config, sink) => { if (config.enabled) sink.publish() }\n'
const manifest = (profile = {}) => ({
  pluginRoots: [],
  profiles: {
    monitor: {
      config: { enabled: true },
      registration: {
        acceptHighCost: true,
        callbackTimeoutMs: 1000,
        events: ['script.compiled'],
        maxQueuedEvents: 16
      },
      use: './modules/diagnostic.mjs',
      ...profile
    }
  },
  schemaVersion: 1
})

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'holo-service-native-profile-')))
  await mkdir(join(home, 'modules'))
  await writeFile(join(home, 'modules', 'diagnostic.mjs'), source, { mode: 0o600 })
  const path = join(home, 'native-observer-profiles.json')
  return {
    home,
    path,
    write: async value => await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  }
}

describe('private Native Observer profile installation', () => {
  it('is empty only when absent and requires a working Native helper when installed', async () => {
    const f = await fixture()
    try {
      assert.equal((await readServiceNativeObserverProfilesV1(f.home)).size, 0)
      await f.write({ profiles: {}, schemaVersion: 1 })
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home), { code: 'service.state_corrupt' })
      if (hasBinary) assert.equal((await readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary })).size, 0)
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)('captures exact Native source bytes and returns immutable versioned resources', async () => {
    const f = await fixture()
    try {
      await f.write(manifest())
      const first = await readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary })
      const profile = first.get('monitor')
      assert.equal(first.size, 1)
      assert.equal(profile.bundle.instanceId, 'observer.monitor')
      assert.equal(profile.bundle.files[0].sha256, createHash('sha256').update(source).digest('hex'))
      assert.deepEqual(profile.registration, {
        acceptHighCost: true,
        callbackTimeoutMs: 1000,
        events: ['script.compiled'],
        maxQueuedEvents: 16
      })
      assert.deepEqual(profile.sink, { maxBytes: 1024 * 1024 })
      assert.match(profile.version, /^[0-9a-f]{64}$/u)
      assert.equal(Object.isFrozen(profile), true)
      assert.equal(Object.isFrozen(profile.bundle.files), true)
      const copied = structuredClone(profile)
      copied.bundle.files[0].source = 'changed'
      assert.equal(first.get('monitor').bundle.files[0].source, source)
      assert.throws(() => normalizeServiceNativeObserverProfilesV1(new Map([['monitor', copied]])))
      await writeFile(join(f.home, 'modules', 'diagnostic.mjs'), `${source}\n`, { mode: 0o600 })
      const second = await readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary })
      assert.notEqual(second.get('monitor').version, profile.version)
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)('reuses a caller-owned Native source ledger without closing it', async () => {
    const f = await fixture()
    let reader
    try {
      await f.write(manifest())
      reader = await createNativeSourceReader({ binaryPath: binary, workspaceRoot: f.home })
      const selected = await readServiceNativeObserverProfilesV1(f.home, { reader })
      assert.equal(selected.get('monitor').bundle.instanceId, 'observer.monitor')
      assert.equal((await reader.statPrivate(f.path)).kind, 'file')
      assert.equal(
        (await readServiceNativeObserverProfilesV1(f.home, { reader })).get('monitor').version,
        selected.get('monitor').version
      )
    } finally {
      await reader?.close()
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)('reuses Native package and Schema reads without executing modules', async () => {
    const f = await fixture()
    try {
      const packageRoot = join(f.home, 'modules', 'diagnostic-package')
      await mkdir(packageRoot)
      await writeFile(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          holo: {
            apiVersion: 1,
            configSchema: './schema.json',
            entry: './index.mjs',
            kind: 'runtime-plugin'
          },
          type: 'module'
        }),
        { mode: 0o600 }
      )
      await writeFile(join(packageRoot, 'index.mjs'), source, { mode: 0o600 })
      const schema = enabled => ({
        additionalProperties: false,
        properties: { enabled: { const: enabled } },
        required: ['enabled'],
        type: 'object'
      })
      await writeFile(join(packageRoot, 'schema.json'), JSON.stringify(schema(true)), { mode: 0o600 })
      await f.write(manifest({ use: './modules/diagnostic-package' }))
      const selected = await readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary })
      assert.equal(selected.get('monitor').bundle.entryUrl, 'holo-plugins:///observer.monitor/index.mjs')
      assert.equal(JSON.stringify(selected.get('monitor').bundle.config), JSON.stringify({ enabled: true }))
      assert.equal(JSON.stringify(selected.get('monitor').bundle.configSchema), JSON.stringify(schema(true)))
      await writeFile(join(packageRoot, 'schema.json'), JSON.stringify(schema(false)), { mode: 0o600 })
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)('rejects private schema, integrity, source and registration violations', async () => {
    const f = await fixture()
    try {
      for (
        const bad of [
          { sink: { maxBytes: 1023 } },
          { sink: null },
          { sink: { maxBytes: null } },
          { sink: { path: './caller.jsonl', maxBytes: 2048 } },
          { registration: { events: ['gc.completed'] } },
          { registration: { events: ['script.compiled'] } },
          { integrity: '0'.repeat(64) },
          { config: { large: 'x'.repeat(64 * 1024) } }
        ]
      ) {
        await f.write(manifest(bad))
        await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
          code: 'service.state_corrupt'
        })
      }
      await f.write({ ...manifest(), extra: true })
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
      await f.write(manifest())
      await writeFile(join(f.home, 'modules', 'diagnostic.mjs'), "import fs from 'node:fs'; export default () => fs\n")
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
      await writeFile(join(f.home, 'modules', 'diagnostic.mjs'), 'export const named = () => undefined\n')
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
      await writeFile(join(f.home, 'modules', 'diagnostic.mjs'), "export default () => import('./other.mjs')\n")
      await writeFile(join(f.home, 'modules', 'other.mjs'), 'export default 1\n')
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it('rejects non-owner and symlink leaves without following them', async () => {
    const f = await fixture()
    try {
      await f.write(manifest())
      await chmod(f.path, 0o640)
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
      await chmod(f.path, 0o600)
      await assert.rejects(
        readBoundedRegularFile(f.path, {
          ownerOnly: true,
          ownerUid: process.getuid() + 1
        }),
        { code: 'service.state_corrupt' }
      )
      const backing = join(f.home, 'backing.json')
      await writeFile(backing, JSON.stringify(manifest()), { mode: 0o600 })
      await rm(f.path)
      await symlink(backing, f.path)
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)('enforces profile, module, graph and file-count ceilings', async () => {
    const f = await fixture()
    try {
      const five = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
        `monitor${index}`,
        manifest().profiles.monitor
      ]))
      await f.write({ pluginRoots: [], profiles: five, schemaVersion: 1 })
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })

      await f.write(manifest())
      await writeFile(
        join(f.home, 'modules', 'diagnostic.mjs'),
        `export default () => {}; /*${'x'.repeat(1024 * 1024)}*/`
      )
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })

      const modules = Array.from(
        { length: 129 },
        (_, index) =>
          writeFile(
            join(f.home, 'modules', `m${index}.mjs`),
            index === 0
              ? `${
                Array.from({ length: 128 }, (__, next) => `import './m${next + 1}.mjs';`).join('\n')
              }\nexport default () => {};\n`
              : `export const value${index} = ${index};\n`
          )
      )
      await Promise.all(modules)
      await f.write(manifest({ use: './modules/m0.mjs' }))
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })

      const nearlyMax = size => {
        const prefix = 'export const value = 1;/*'
        return `${prefix}${'x'.repeat(size - prefix.length - 2)}*/`
      }
      await Promise.all(
        Array.from(
          { length: 4 },
          (_, index) => writeFile(join(f.home, 'modules', `big${index}.mjs`), nearlyMax(1_048_553))
        )
      )
      await writeFile(
        join(f.home, 'modules', 'big-entry.mjs'),
        `${
          Array.from({ length: 4 }, (_, index) => `import './big${index}.mjs';`).join('\n')
        }\nexport default () => {};\n`
      )
      await f.write(manifest({ use: './modules/big-entry.mjs' }))
      await assert.rejects(readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary }), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)('clones Map data, rejects accessors/functions and verifies supplied version', async () => {
    const f = await fixture()
    try {
      await f.write(manifest())
      const selected = (await readServiceNativeObserverProfilesV1(f.home, { binaryPath: binary })).get('monitor')
      const mutable = structuredClone(selected)
      const normalized = normalizeServiceNativeObserverProfilesV1(new Map([['monitor', mutable]]))
      mutable.sink.maxBytes = 2048
      assert.equal(normalized.get('monitor').sink.maxBytes, 1024 * 1024)
      assert.throws(() =>
        normalizeServiceNativeObserverProfilesV1({
          monitor: {
            ...selected,
            version: '0'.repeat(64)
          }
        })
      )
      assert.throws(() =>
        normalizeServiceNativeObserverProfilesV1(
          new Map([['monitor', {
            ...selected,
            callback: () => undefined
          }]])
        )
      )
      assert.throws(() =>
        normalizeServiceNativeObserverProfilesV1({
          monitor: {
            ...selected,
            sink: { maxBytes: null }
          }
        })
      )
      const proxied = new Proxy({ ...selected }, {
        ownKeys: () => {
          throw new Error('must not run')
        }
      })
      assert.throws(
        () => normalizeServiceNativeObserverProfilesV1({ monitor: proxied }),
        error => error.message !== 'must not run'
      )
      let rootTrapCalls = 0
      const rootMapProxy = new Proxy(new Map([['monitor', selected]]), {
        getPrototypeOf: () => {
          rootTrapCalls++
          throw new Error('must not run')
        }
      })
      assert.throws(
        () => normalizeServiceNativeObserverProfilesV1(rootMapProxy),
        error => error.message !== 'must not run'
      )
      assert.equal(rootTrapCalls, 0)
      const accessor = { ...selected }
      Object.defineProperty(accessor, 'sink', {
        get: () => {
          throw new Error('must not run')
        }
      })
      assert.throws(
        () => normalizeServiceNativeObserverProfilesV1({ monitor: accessor }),
        error => error.message !== 'must not run'
      )
    } finally {
      await rm(f.home, { force: true, recursive: true })
    }
  })

  it.skipIf(!hasBinary)(
    'passes private profiles through lifecycle, server and core without publishing them',
    async () => {
      const f = await fixture()
      let lifecycle
      let service
      try {
        await f.write(manifest({ config: { enabled: true, secret: 'PRIVATE_PROFILE_MARKER' } }))
        await writeFile(
          join(f.home, 'native-runtime.json'),
          JSON.stringify({ executablePath: binary, schemaVersion: 1 }),
          { mode: 0o600 }
        )
        let forwarded
        lifecycle = createHolonomyServiceLifecycleManager({
          client: { status: async () => ({ running: false }) },
          createService: options => {
            forwarded = options
            return {
              close: async () => undefined,
              core: { snapshot: () => ({ resources: { inspectors: {}, processes: {} } }) },
              start: async () => 'http://127.0.0.1:43210'
            }
          },
          home: f.home
        })
        await lifecycle.ensure()
        assert.equal(forwarded.nativeObserverProfiles.get('monitor').bundle.instanceId, 'observer.monitor')
        service = createHolonomyService({
          nativeObserverProfiles: forwarded.nativeObserverProfiles,
          port: 0,
          stateDirectory: join(f.home, 'state'),
          token: 'private-observer-registry-test-token-1234'
        })
        assert.equal(createdRuntimeManager.options.nativeObserverProfiles, forwarded.nativeObserverProfiles)
        const base = await service.start()
        const response = await fetch(`${base}/v1/service`, {
          headers: { authorization: 'Bearer private-observer-registry-test-token-1234' }
        })
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.equal(body.includes('PRIVATE_PROFILE_MARKER'), false)
        assert.equal(body.includes('nativeObserverProfiles'), false)
        assert.equal(body.includes(f.home), false)
      } finally {
        await service?.close()
        await lifecycle?.stop({ drain: true }).catch(() => undefined)
        await rm(f.home, { force: true, recursive: true })
      }
    }
  )
})
