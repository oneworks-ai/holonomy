import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const directory = mkdtempSync(join(tmpdir(), 'holonomy-package-layout-'))

try {
  const output = execFileSync('npm', ['pack', '--json', '--pack-destination', directory], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  const result = JSON.parse(output)[0]
  const files = new Set(result.files.map(file => file.path))
  for (
    const required of [
      '.oo/skills/manage-runtime-process/references/process-api.md',
      'adapters/android/e2e/tools/prepare-runtime-assets.mjs',
      'adapters/android/gradle/wrapper/gradle-wrapper.jar',
      'adapters/android/gradlew',
      'adapters/android/session-host/src/main/AndroidManifest.xml',
      'adapters/node/src/index.mjs',
      'dist/index.js',
      'src/runtime/runtime.ts',
      'tools/holonomy.mjs',
      'tools/service/entry.mjs'
    ]
  ) assert.ok(files.has(required), `Packaged Holonomy file is missing: ${required}`)
  for (const file of files) {
    assert.ok(!file.includes('/__tests__/'), `Package contains tests: ${file}`)
    assert.ok(!file.endsWith('/AGENTS.md') && file !== 'AGENTS.md', `Package contains internal guidance: ${file}`)
    assert.ok(!file.endsWith('/vitest.config.mjs'), `Package contains test configuration: ${file}`)
  }
  assert.ok(result.size < 1_000_000, `Package tarball exceeds 1 MiB: ${result.size}`)
  assert.ok(result.unpackedSize < 4_000_000, `Unpacked package exceeds 4 MiB: ${result.unpackedSize}`)
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(packageJson.bin.holonomy, './tools/holonomy.mjs')
  execFileSync('tar', ['-xzf', join(directory, result.filename), '-C', directory])
  const nodeModules = join(directory, 'installed', 'node_modules')
  const packageRoot = join(nodeModules, '@oneworks', 'holonomy')
  mkdirSync(join(nodeModules, '@oneworks'), { recursive: true })
  renameSync(join(directory, 'package'), packageRoot)
  for (const dependency of ['acorn', 'ajv', 'electron']) {
    symlinkSync(resolve('node_modules', dependency), join(nodeModules, dependency))
  }
  const help = execFileSync(process.execPath, [join(packageRoot, 'tools/holonomy.mjs'), '--help'], {
    encoding: 'utf8'
  })
  assert.match(help, /Holonomy Runtime CLI/u)
  assert.ok(existsSync(join(packageRoot, 'adapters/android/gradlew')))
  assert.equal(packageJson.optionalDependencies.electron, '43.3.0')
  const launcher = await import(pathToFileURL(join(packageRoot, 'tools/holonomy-devtools-launcher.mjs')).href)
  assert.ok(existsSync(launcher.resolveHolonomyElectronExecutable()))
  const adapter = await import(pathToFileURL(join(packageRoot, 'adapters/node/src/index.mjs')).href)
  const supervisor = new adapter.NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  const logs = []
  supervisor.on('log', event => logs.push(event))
  try {
    await supervisor.start({
      entryUrl: 'app://installed/main.mjs',
      runtimeModules: [],
      syntheticModules: {},
      userModules: [{ source: "console.log('PACKAGED_RUNTIME_OK')", url: 'app://installed/main.mjs' }]
    })
    assert.ok(logs.some(event => event.text === 'PACKAGED_RUNTIME_OK'))
  } finally {
    await supervisor.stop()
  }
} finally {
  rmSync(directory, { force: true, recursive: true })
}
