import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const directory = mkdtempSync(join(tmpdir(), 'holonomy-package-layout-'))
const MEBIBYTE = 1024 * 1024
const packageDirectory = (specifier, from = import.meta.url) => {
  let current = dirname(createRequire(from).resolve(specifier))
  while (current !== dirname(current)) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === specifier) return current
    current = dirname(current)
  }
  throw new Error(`Installed package root is unavailable: ${specifier}`)
}

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
      'conformance/capabilities/filesystem-v1.test.mjs',
      'conformance/capabilities/process-v86.test.mjs',
      'conformance/capabilities/system-projection-fixture.mjs',
      'conformance/capabilities/system-projection.test.mjs',
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
  assert.ok(result.size < MEBIBYTE, `Package tarball exceeds 1 MiB: ${result.size}`)
  assert.ok(
    result.unpackedSize < 4.75 * MEBIBYTE,
    `Unpacked package exceeds the 4.75 MiB Capability Runtime and plugin budget: ${result.unpackedSize}`
  )
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(packageJson.bin.holonomy, './tools/holonomy.mjs')
  const rootTarball = join(directory, result.filename)
  const installRoot = join(directory, 'installed')
  const nodeModules = join(installRoot, 'node_modules')
  const workspacePackages = [
    ['holouv', 'packages/holouv'],
    ['runtime', 'packages/runtime'],
    ['capability-device', 'packages/capabilities/device'],
    ['capability-fs', 'packages/capabilities/fs'],
    ['capability-network', 'packages/capabilities/network'],
    ['capability-process', 'packages/capabilities/process'],
    ['capability-system', 'packages/capabilities/system'],
    ['plugin-audit', 'packages/plugins/audit'],
    ['plugin-permission', 'packages/plugins/permission']
  ]
  const packedWorkspaceDependencies = {}
  for (const [name, workspacePath] of workspacePackages) {
    const workspacePackRoot = join(directory, `workspace-${name}`)
    mkdirSync(workspacePackRoot)
    const workspacePack = JSON.parse(execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', workspacePackRoot],
      { cwd: resolve(workspacePath), encoding: 'utf8', maxBuffer: 16 * MEBIBYTE }
    ))[0]
    for (const file of workspacePack.files) {
      assert.ok(!file.path.includes('/__tests__/'), `Workspace package contains tests: ${name}/${file.path}`)
      assert.ok(!file.path.endsWith('/AGENTS.md'), `Workspace package contains internal guidance: ${name}/${file.path}`)
    }
    packedWorkspaceDependencies[`@holonomyjs/${name}`] = `file:${join(workspacePackRoot, workspacePack.filename)}`
  }
  const ajvManifest = pathToFileURL(join(packageDirectory('ajv'), 'package.json')).href
  const cordisManifest = pathToFileURL(join(packageDirectory('cordis'), 'package.json')).href
  const packedExternalDependencies = Object.fromEntries([
    ['acorn', packageDirectory('acorn')],
    ['ajv', packageDirectory('ajv')],
    ['cordis', packageDirectory('cordis')],
    ...['fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string']
      .map(name => [name, packageDirectory(name, ajvManifest)]),
    ...['@standard-schema/spec', 'cosmokit']
      .map(name => [name, packageDirectory(name, cordisManifest)])
  ].map(([name, packagePath]) => [name, `file:${packagePath}`]))
  mkdirSync(installRoot, { recursive: true })
  writeFileSync(
    join(installRoot, 'package.json'),
    `${
      JSON.stringify(
        {
          dependencies: {
            holonomy: `file:${rootTarball}`,
            ...packedExternalDependencies,
            ...packedWorkspaceDependencies
          },
          name: 'holonomy-installed-layout-consumer',
          pnpm: { overrides: { ...packedExternalDependencies, ...packedWorkspaceDependencies } },
          private: true,
          version: '1.0.0'
        },
        null,
        2
      )
    }\n`
  )
  execFileSync(
    'pnpm',
    ['install', '--offline', '--ignore-scripts', '--no-frozen-lockfile', '--no-optional'],
    { cwd: installRoot, encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: 'pipe' }
  )
  const packageRoot = join(nodeModules, 'holonomy')
  assert.ok(existsSync(join(packageRoot, 'package.json')), 'The packed root package was not installed')
  for (const [name] of workspacePackages) {
    assert.ok(
      existsSync(join(nodeModules, '@holonomyjs', name, 'package.json')),
      `The packed workspace dependency was not installed: @holonomyjs/${name}`
    )
  }
  const androidAssets = join(directory, 'android-assets')
  execFileSync(process.execPath, [
    join(packageRoot, 'adapters/android/e2e/tools/prepare-runtime-assets.mjs'),
    join(packageRoot, 'dist'),
    join(packageRoot, 'src'),
    join(packageRoot, 'adapters/android/e2e/src/runtimeBootstrap'),
    join(packageRoot, 'adapters/android/e2e/src/runtimeFixtures'),
    join(nodeModules, 'acorn/dist/acorn.mjs'),
    androidAssets
  ], { env: { ...process.env, HOLO_V86_PROBE_ASSET_ROOT: '' } })
  const androidManifest = JSON.parse(
    readFileSync(join(androidAssets, 'runtime/asset-manifest.json'), 'utf8')
  )
  assert.ok(
    androidManifest.assets.some(asset => asset.source === 'packages/runtime/dist/app/runtime.js'),
    'Android installed layout did not resolve @holonomyjs/runtime'
  )
  assert.ok(
    androidManifest.typescriptSources.some(source => source.path.startsWith('packages/capabilities/fs/src/')),
    'Android installed layout did not resolve Capability package sources'
  )
  assert.ok(
    androidManifest.moduleAliases.some(alias => alias.specifier === '@holonomyjs/capability-fs'),
    'Android installed layout did not preserve Capability package module aliases'
  )
  for (const specifier of ['@holonomyjs/plugin-audit', '@holonomyjs/plugin-permission']) {
    assert.ok(
      androidManifest.moduleAliases.some(alias => alias.specifier === specifier),
      `Android installed layout did not preserve trusted Runtime library alias: ${specifier}`
    )
  }
  assert.ok(
    androidManifest.assets.every(asset => !asset.source.startsWith('../')),
    'Android Runtime manifest leaked an installed Host path'
  )
  const help = execFileSync(process.execPath, [join(packageRoot, 'tools/holonomy.mjs'), '--help'], {
    encoding: 'utf8'
  })
  assert.match(help, /Holonomy Runtime CLI/u)
  assert.ok(existsSync(join(packageRoot, 'adapters/android/gradlew')))
  assert.equal(packageJson.optionalDependencies.electron, '43.3.0')
  const launcher = await import(pathToFileURL(join(packageRoot, 'tools/holonomy-devtools-launcher.mjs')).href)
  assert.throws(
    () => launcher.resolveHolonomyElectronExecutable(),
    /Electron is unavailable\. Install the optional electron dependency/u
  )
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
