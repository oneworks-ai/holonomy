import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { test } from 'vitest'

import { prepareRuntimeAssets } from '../asset-packager.mjs'
import { verifyRuntimeAssets } from '../verify-runtime-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

test('production graph excludes E2E payloads and boots the real shared Runtime with private drivers', async () => {
  const outputRoot = mkdtempSync(resolve(tmpdir(), 'holo-runtime-host-test-'))
  try {
    await prepareRuntimeAssets({
      compiledRoot: resolve(root, 'dist'),
      sourceRoot: resolve(root, 'src'),
      bootstrapRoot: resolve(root, 'adapters/android/runtime-host/src/runtimeBootstrap'),
      acornPath: resolve(root, 'node_modules/acorn/dist/acorn.mjs'),
      outputRoot
    })
    const manifest = JSON.parse(readFileSync(resolve(outputRoot, 'runtime/asset-manifest.json'), 'utf8'))
    verifyRuntimeAssets(manifest, outputRoot)
    for (const asset of manifest.assets) {
      assert.equal(asset.guestReadable, false)
      assert.ok(['bootstrap', 'runtime-output', 'vendor'].includes(asset.kind))
      assert.doesNotMatch(asset.path, /\/(?:fixtures|process-backends)\/|rootfs|\.(?:bin|img|iso)$/iu)
      assert.doesNotMatch(asset.source, /e2e|runtimeFixtures|backendProbe/u)
      assert.doesNotMatch(
        readFileSync(resolve(outputRoot, asset.path), 'utf8'),
        /__oneworksHolonomy\s*=|exerciseEventLoop|exerciseNativeCompletion/u
      )
    }
    const installed = []
    const output = []
    const host = {
      architecture: () => 'arm64',
      processConfiguration: () =>
        JSON.stringify({ argv: [], cwd: '/runtime', env: {}, execPath: '/runtime/holo', pid: 1 }),
      cryptoAvailable: () => false,
      nativeConfiguration: () => '{}',
      capabilityConfiguration: () => null,
      checkpointMicrotasks() {},
      now: () => 0,
      requestWakeup() {},
      terminate() {},
      scheduleTimer: () => 1,
      cancelTimer() {},
      writeOutput: (...values) => output.push(values),
      installSyntheticModules: modules => installed.push(modules),
      nativeDispose() {},
      nativeCancel() {},
      nativeCloseResource() {},
      nativeGrantCredits() {}
    }
    const context = vm.createContext({ __oneworksAndroidHost: host })
    const cache = new Map()
    const aliases = new Map(manifest.moduleAliases.map(alias => [alias.specifier, alias.path]))
    const vendor = { acorn: 'acorn', cordis: 'cordis', cosmokit: 'cosmokit' }
    const load = (specifier, referencing) => {
      const url = aliases.has(specifier)
        ? `holonomy:///${aliases.get(specifier)}`
        : vendor[specifier]
        ? `holonomy:///runtime/vendor/${vendor[specifier]}.mjs`
        : new URL(specifier, referencing?.identifier ?? 'holonomy:///runtime/').href
      if (!cache.has(url)) {
        assert.ok(url.startsWith('holonomy:///runtime/'))
        const source = readFileSync(resolve(outputRoot, new URL(url).pathname.slice(1)), 'utf8')
        cache.set(url, new vm.SourceTextModule(source, { context, identifier: url }))
      }
      return cache.get(url)
    }
    const bootstrap = load('holonomy:///runtime/bootstrap.mjs')
    await bootstrap.link(load)
    await bootstrap.evaluate()
    await vm.runInContext('__oneworksAndroidReady()', context)
    assert.equal(vm.runInContext('typeof __oneworksAndroidHost', context), 'undefined')
    assert.equal(vm.runInContext('typeof __oneworksHolonomy', context), 'undefined')
    assert.equal(vm.runInContext('typeof fetch', context), 'undefined')
    assert.equal(vm.runInContext('typeof crypto', context), 'undefined')
    assert.equal(installed.length, 1)
    for (const driver of ['Ready', 'Turn', 'Timer', 'Native', 'TrustedBackend']) {
      assert.equal(typeof context[`__oneworksAndroid${driver}`], 'function')
      delete context[`__oneworksAndroid${driver}`] // Javet captures/removes these before Guest.
    }
    assert.equal(typeof context.__oneworksHolonomyControl, 'function')
    delete context.__oneworksHolonomyControl
    vm.runInContext("console.log('production booted')", context)
    assert.deepEqual(output, [['stdout', '[log] production booted\n']])
  } finally {
    rmSync(outputRoot, { recursive: true, force: true })
  }
})
