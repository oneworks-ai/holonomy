import { Buffer } from 'node:buffer'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { androidBuildEnvironment, resolveAndroidSdkRoot } from '../../tools/android-devtools-adb.mjs'
import { androidNetworkFixtureReverseArgs } from '../../tools/holonomy-android-session.mjs'
import { parseHolonomyArgs } from '../../tools/holonomy-cli-options.mjs'
import { runWrapperSource, testRunnerSource } from '../../tools/holonomy-entry-source.mjs'
import { readHolonomyDocumentation } from '../../tools/holonomy-help.mjs'
import {
  prepareHolonomyLaunchSnapshot,
  readHolonomyCapabilityRuntime,
  readHolonomySandboxPolicy
} from '../../tools/holonomy-launch-snapshot.mjs'
import { runHolonomyRuntimeCommand } from '../../tools/holonomy-managed-command.mjs'
import { parseAndRunHolonomyManagementCommand } from '../../tools/holonomy-management-command.mjs'
import { parseHolonomyManagementArgs } from '../../tools/holonomy-management-options.mjs'
import { expandHolonomyEntries } from '../../tools/holonomy-module-graph.mjs'
import { requiresHolonomyNetworkFixture } from '../../tools/holonomy-network-fixture.mjs'
import { readHolonomyNetworkRules } from '../../tools/holonomy-network-rules-file.mjs'
import { prepareHolonomyRuntimePlugins } from '../../tools/holonomy-plugin-bundle.mjs'
import { startHolonomyPluginWatch } from '../../tools/holonomy-plugin-watch.mjs'
import { HOLONOMY_SESSION_LIMITS, encodeHolonomySession } from '../../tools/holonomy-session-envelope.mjs'

describe('holonomy CLI module graph', () => {
  it('requires an explicit target and admits managed launch options', () => {
    expect(() => parseHolonomyArgs(['run', 'entry.mjs'])).toThrow('--target android|node is required')
    expect(parseHolonomyArgs([
      'run',
      '--target',
      'node',
      '--detach',
      '--openapi',
      'http://127.0.0.1:9123',
      '--openapi-token-file',
      './token',
      '--capability-runtime',
      './capability.json',
      '--network-rules',
      './rules.json',
      '--sandbox',
      './sandbox.json',
      'entry.mjs'
    ])).toMatchObject({
      options: {
        detach: true,
        capabilityRuntime: './capability.json',
        networkRules: './rules.json',
        openapi: 'http://127.0.0.1:9123',
        sandbox: './sandbox.json',
        target: 'node'
      }
    })
    expect(() =>
      parseHolonomyArgs([
        'run',
        '--target',
        'android',
        '--isolation',
        'isolatedProcess',
        'entry.mjs'
      ])
    ).not.toThrow()
    expect(() => parseHolonomyArgs(['run', '--target', 'node', '--sandbox', ''])).toThrow(
      '--sandbox requires one JSON file'
    )
    expect(() => parseHolonomyArgs(['run', '--target', 'node', '--capability-runtime', ''])).toThrow(
      '--capability-runtime requires one JSON file'
    )
    expect(() => parseHolonomyArgs(['run', '--target', 'android', '--no-build', 'entry.mjs'])).toThrow(
      'Unknown option: --no-build'
    )
    expect(() => parseHolonomyArgs(['run', '--target', 'android', '--watch', 'entry.mjs'])).toThrow(
      '--watch is supported by Node/Desktop Runtime only'
    )
  })

  it('builds relative Runtime plugins into private canonical holo-plugins Bundles', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-plugin-'))
    try {
      writeFileSync(join(temporaryRoot, 'plugin.mjs'), 'export default () => undefined')
      writeFileSync(
        join(temporaryRoot, 'holo.config.json'),
        JSON.stringify({
          plugins: [{ config: { enabled: true }, id: 'local', use: './plugin.mjs' }]
        })
      )
      const prepared = prepareHolonomyRuntimePlugins('./holo.config.json', { cwd: temporaryRoot })
      expect(prepared.bundles).toHaveLength(1)
      expect(prepared.bundles[0]).toMatchObject({
        entryUrl: 'holo-plugins:///local/plugin.mjs',
        instanceId: 'local',
        rootUrl: 'holo-plugins:///local/',
        schemaVersion: 1
      })
      expect(JSON.stringify(prepared.bundles)).not.toContain(temporaryRoot)
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  it('rejects plugin modules that are not strict UTF-8 source', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-plugin-invalid-utf8-'))
    try {
      writeFileSync(join(temporaryRoot, 'plugin.mjs'), Buffer.from([0x65, 0x78, 0xFF]))
      writeFileSync(
        join(temporaryRoot, 'holo.config.json'),
        JSON.stringify({ plugins: [{ id: 'invalid', use: './plugin.mjs' }] })
      )
      expect(() => prepareHolonomyRuntimePlugins('./holo.config.json', { cwd: temporaryRoot }))
        .toThrow('strict UTF-8 source')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  it('watches config changes with one ordered last-known-good graph revision', async () => {
    const callbacks: Array<(event: string, filename?: string) => void> = []
    const diagnostics: string[] = []
    const replacements: unknown[] = []
    let prepareCalls = 0
    let updated!: () => void
    const updateStarted = new Promise<void>(resolve => updated = resolve)
    const bundle = (digit: string) => ({
      bundleSha256: digit.repeat(64),
      config: {},
      entryUrl: 'holo-plugins:///plugin/index.mjs' as const,
      exportName: 'default',
      files: [],
      instanceId: 'plugin',
      rootUrl: 'holo-plugins:///plugin/' as const,
      schemaVersion: 1 as const
    })
    const initial = [bundle('a')]
    const replacement = [bundle('b')]
    const watcher = startHolonomyPluginWatch({
      client: {
        replaceRuntimePlugins: async (...args: unknown[]) => {
          replacements.push(args)
          updated()
          return { value: { operation: { id: 'operation_plugins' } } }
        }
      },
      configPath: '/workspace/holo.config.json',
      dependencies: {
        cancelWatch: () => undefined,
        prepareRuntimePlugins: () => {
          prepareCalls += 1
          if (prepareCalls === 1) return { bundles: replacement }
          throw new Error('invalid candidate')
        },
        scheduleWatch: callback => {
          callback()
          return 1
        },
        waitForOperation: async () => ({ result: { process: { pluginGraphRevision: 2 } } }),
        watchDirectory: (_directory, callback) => {
          callbacks.push(callback)
          return { close: () => undefined, on: () => undefined }
        }
      },
      io: { stderr: { write: value => diagnostics.push(value) } },
      pluginRoots: [],
      process: { generation: 1, id: 'process_plugins', pluginGraphRevision: 1 },
      runtimePlugins: initial
    })
    callbacks[0]!('change', 'holo.config.json')
    await updateStarted
    await Promise.resolve()
    callbacks[0]!('change', 'holo.config.json')
    await Promise.resolve()
    await watcher.close()
    expect(replacements).toHaveLength(1)
    expect(diagnostics.join('')).toContain('updated to revision 2')
  })
  it('matches globstar entries directly below the selected directory', () => {
    const entries = expandHolonomyEntries(['conformance/specs/**/*.test.mjs'])
      .map(entry => relative(process.cwd(), entry).replaceAll('\\', '/'))

    expect(entries).toEqual([
      'conformance/specs/console.test.mjs',
      'conformance/specs/fetch.test.mjs',
      'conformance/specs/node-modules.test.mjs',
      'conformance/specs/timers.test.mjs'
    ])
  })

  it('keeps the guest process exitCode in the run wrapper', () => {
    expect(runWrapperSource('app+local://workspace/entry.mjs')).toContain('process.exit(process.exitCode)')
    expect(runWrapperSource('app+local://workspace/entry.mjs', true)).toContain(
      'setInterval(() => {}, 2_147_483_647)'
    )
    expect(runWrapperSource('app+local://workspace/entry.mjs', true)).not.toContain(
      'process.exit(process.exitCode)'
    )
  })

  it('keeps TAP and JSON rendering in the CLI-generated test entry', () => {
    const source = testRunnerSource(['app+local://workspace/example.test.mjs'], 'tap')
    expect(source).toContain('const renderHolonomyTap = summary =>')
    expect(source).toContain("import { run } from 'node:test'")
    expect(source).toContain('# holonomy-result ')
  })

  it('rejects oversized session metadata before invoking ADB', () => {
    expect(() =>
      encodeHolonomySession({
        argv: Array.from({ length: HOLONOMY_SESSION_LIMITS.maxArgs + 1 }, () => ''),
        entryUrl: 'app+local://workspace/entry.mjs',
        env: {},
        modules: [{ source: 'export {}', url: 'app+local://workspace/entry.mjs' }],
        schemaVersion: 1
      })
    ).toThrow('Runtime argv exceeds the session limit')
  })

  it('starts the network fixture only for tests that include fetch conformance', () => {
    const fetchEntry = resolve('conformance/specs/fetch.test.mjs')
    const timersEntry = resolve('conformance/specs/timers.test.mjs')

    expect(requiresHolonomyNetworkFixture('test', [fetchEntry])).toBe(true)
    expect(requiresHolonomyNetworkFixture('test', [timersEntry])).toBe(false)
    expect(requiresHolonomyNetworkFixture('run', [fetchEntry])).toBe(false)
  })

  it('scopes network reverse setup and cleanup to the selected serial', () => {
    expect(androidNetworkFixtureReverseArgs('device-123', 48_321)).toEqual({
      add: ['-s', 'device-123', 'reverse', 'tcp:48321', 'tcp:48321'],
      remove: ['-s', 'device-123', 'reverse', '--remove', 'tcp:48321']
    })
  })

  it('compiles a target-neutral immutable launch snapshot before contacting the service', () => {
    const parsed = parseHolonomyArgs([
      'run',
      '--target',
      'node',
      '--capability-runtime',
      'capability.json',
      'conformance/specs/console.test.mjs'
    ])
    const snapshot = prepareHolonomyLaunchSnapshot(parsed.command, parsed.options, {
      randomUUID: () => 'fixed-id',
      readCapabilityRuntime: () => ({ processProfileId: 'developer', schemaVersion: 1 })
    })
    expect(snapshot).toMatchObject({
      capabilityRuntime: { processProfileId: 'developer', schemaVersion: 1 },
      inspectorMode: 'off',
      launch: {
        command: 'run',
        moduleRootUrl: 'app+local://workspace/',
        schemaVersion: 2,
        target: 'node'
      },
      sandboxPolicy: {
        filesystem: { access: 'none' },
        network: { access: 'none' },
        schemaVersion: 1
      },
      target: 'node'
    })
    expect(snapshot.entryUrl).toContain('.holonomy/run-fixed-id.mjs')
    expect(Object.isFrozen(snapshot.launch.modules)).toBe(true)
  })

  it('reads a bounded JSON network rule set without following a symlink', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-rules-'))
    try {
      writeFileSync(join(temporaryRoot, 'rules.json'), '{"mode":"passthrough","rules":[]}')
      symlinkSync(join(temporaryRoot, 'rules.json'), join(temporaryRoot, 'linked.json'))
      expect(readHolonomyNetworkRules('./rules.json', { cwd: temporaryRoot })).toEqual({
        mode: 'passthrough',
        rules: []
      })
      expect(() => readHolonomyNetworkRules('./linked.json', { cwd: temporaryRoot }))
        .toThrow('must not be a symbolic link')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  it('reads one bounded immutable sandbox policy without following a symlink', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-sandbox-'))
    try {
      const policy = {
        filesystem: { access: 'none' },
        network: { access: 'none' },
        schemaVersion: 1
      }
      writeFileSync(join(temporaryRoot, 'sandbox.json'), JSON.stringify(policy))
      symlinkSync(join(temporaryRoot, 'sandbox.json'), join(temporaryRoot, 'linked.json'))
      writeFileSync(join(temporaryRoot, 'oversized.json'), ' '.repeat((1024 * 1024) + 1))
      const read = readHolonomySandboxPolicy('./sandbox.json', { cwd: temporaryRoot })
      expect(read).toEqual(policy)
      expect(Object.isFrozen(read)).toBe(true)
      expect(Object.isFrozen(read.network)).toBe(true)
      expect(() => readHolonomySandboxPolicy('./linked.json', { cwd: temporaryRoot }))
        .toThrow('must not be a symbolic link')
      expect(() => readHolonomySandboxPolicy('./oversized.json', { cwd: temporaryRoot }))
        .toThrow('exceeds the size limit')
      expect(() => readHolonomySandboxPolicy('./sandbox.txt', { cwd: temporaryRoot }))
        .toThrow('must reference one JSON file')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  it('reads an immutable Capability Runtime launch file without following a symlink', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-capability-runtime-'))
    try {
      const configuration = { processProfileId: 'developer', schemaVersion: 1 }
      writeFileSync(join(temporaryRoot, 'capability.json'), JSON.stringify(configuration))
      symlinkSync(join(temporaryRoot, 'capability.json'), join(temporaryRoot, 'linked.json'))
      const read = readHolonomyCapabilityRuntime('./capability.json', { cwd: temporaryRoot })
      expect(read).toEqual(configuration)
      expect(Object.isFrozen(read)).toBe(true)
      expect(() => readHolonomyCapabilityRuntime('./linked.json', { cwd: temporaryRoot }))
        .toThrow('must not be a symbolic link')
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  it('parses service, device, emulator and process management commands', () => {
    expect(parseHolonomyManagementArgs(['service', 'start', '--listen', '127.0.0.1', '--port', '0']))
      .toMatchObject({ action: 'start', group: 'service', options: { port: 0 } })
    expect(parseHolonomyManagementArgs(['service', 'token', 'rotate']))
      .toMatchObject({ action: 'rotate', group: 'service' })
    expect(parseHolonomyManagementArgs(['device', 'show', 'android:emulator-5554']))
      .toMatchObject({ group: 'device', id: 'android:emulator-5554' })
    expect(parseHolonomyManagementArgs(['emulator', 'start', 'Pixel_9', '--wait']))
      .toMatchObject({ group: 'emulator', options: { avd: 'Pixel_9', wait: true } })
    expect(parseHolonomyManagementArgs([
      'process',
      'restart',
      'process_1',
      '--expected-generation',
      '2'
    ])).toMatchObject({ group: 'process', id: 'process_1', options: { expectedGeneration: 2 } })
  })

  it('launches a detached runtime through the service without a direct ADB fallback', async () => {
    const calls: string[] = []
    const output: string[] = []
    const client = {
      call: async (path: string) => {
        calls.push(path)
        if (path === '/v1/devices:refresh') {
          return [{ id: 'node:local', platform: 'node', state: 'online' }]
        }
        throw new Error(`Unexpected call: ${path}`)
      },
      launchProcess: async (input: unknown) => {
        calls.push(`launch:${JSON.stringify(input)}`)
        return {
          value: {
            operation: { id: 'operation_1' },
            process: { generation: 1, id: 'process_1', state: 'queued' }
          }
        }
      }
    }
    const parsed = parseHolonomyArgs(['run', '--target', 'node', '--detach', 'entry.mjs'])
    await expect(runHolonomyRuntimeCommand(parsed, {
      stderr: { write: () => undefined },
      stdout: { write: value => output.push(value) }
    }, {
      createClient: () => client,
      ensureService: async () => ({ running: true }),
      prepareLaunch: () => ({
        capabilityRuntime: { processProfileId: 'developer', schemaVersion: 1 },
        entryUrl: 'app+local://workspace/main.mjs',
        inspectorMode: 'off',
        isolation: 'runtime',
        launch: { argv: [], env: {}, modules: [] },
        target: 'node'
      })
    })).resolves.toBe(0)
    expect(calls[0]).toBe('/v1/devices:refresh')
    expect(calls[1]).toContain('"deviceId":"node:local"')
    expect(calls[1]).toContain('"processProfileId":"developer"')
    expect(JSON.parse(output.join(''))).toEqual({
      generation: 1,
      processId: 'process_1',
      state: 'queued'
    })
  })

  it('reads service status without auto-starting a stopped service', async () => {
    const output: string[] = []
    let ensureCalls = 0
    const result = await parseAndRunHolonomyManagementCommand(['service', 'status'], {
      stderr: { write: () => undefined },
      stdout: { write: value => output.push(value) }
    }, {
      createClient: () => ({ status: async () => ({ running: false }) }),
      ensureService: async () => {
        ensureCalls += 1
      }
    })
    expect(result).toBe(0)
    expect(ensureCalls).toBe(0)
    expect(JSON.parse(output.join(''))).toEqual({ running: false })
  })

  it('does not derive the current directory as the SDK root from a bare PATH adb', () => {
    const environment = androidBuildEnvironment('adb', { JAVA_HOME: '/java', PATH: '/usr/bin' }, '/missing-home')
    expect(environment.ANDROID_HOME).toBeUndefined()
    expect(environment.ANDROID_SDK_ROOT).toBeUndefined()
    expect(Object.values(environment)).not.toContain('.')
  })

  it('prefers an existing SDK environment root and derives an existing absolute adb candidate', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-sdk-'))
    const environmentSdk = join(temporaryRoot, 'environment-sdk')
    const adbSdk = join(temporaryRoot, 'adb-sdk')
    const absoluteAdb = join(adbSdk, 'platform-tools', 'adb')
    try {
      mkdirSync(environmentSdk)
      mkdirSync(join(adbSdk, 'platform-tools'), { recursive: true })
      writeFileSync(absoluteAdb, '')
      chmodSync(absoluteAdb, 0o755)

      expect(resolveAndroidSdkRoot(absoluteAdb, { ANDROID_HOME: environmentSdk }, '/missing-home'))
        .toBe(environmentSdk)
      expect(resolveAndroidSdkRoot(absoluteAdb, {}, '/missing-home')).toBe(adbSdk)
      expect(androidBuildEnvironment(absoluteAdb, { JAVA_HOME: '/java' }, '/missing-home')).toMatchObject({
        ANDROID_HOME: adbSdk,
        ANDROID_SDK_ROOT: adbSdk
      })
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })

  it('routes human help to README and machine documentation discovery', () => {
    const help = readHolonomyDocumentation(['--help'])
    expect(help).toContain('holonomy --readme [MARKDOWN]')
    expect(help).toContain('holonomy --llms [MARKDOWN]')
    expect(help).toContain('--sandbox FILE')
    const readme = readHolonomyDocumentation(['--readme'])
    expect(readme).toContain('# Holonomy CLI')
    expect(readHolonomyDocumentation(['--llms'])).toBe(readme)
  })

  it('reads only one explicitly selected bounded Markdown reference', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'holonomy-llms-'))
    try {
      writeFileSync(join(temporaryRoot, 'scenario.md'), '# Scenario')
      writeFileSync(join(temporaryRoot, 'scenario.txt'), 'private')
      writeFileSync(join(temporaryRoot, 'oversized.md'), 'x'.repeat(256 * 1024 + 1))
      writeFileSync(join(temporaryRoot, 'invalid-utf8.md'), new Uint8Array([0xFF]))
      mkdirSync(join(temporaryRoot, 'directory.md'))
      symlinkSync(join(temporaryRoot, 'scenario.txt'), join(temporaryRoot, 'linked.md'))
      for (const command of ['--readme', '--llms']) {
        expect(readHolonomyDocumentation([command, './scenario.md'], { cwd: temporaryRoot }))
          .toBe('# Scenario\n')
        expect(() => readHolonomyDocumentation([command, './scenario.txt'], { cwd: temporaryRoot }))
          .toThrow('must be a Markdown file')
        expect(() => readHolonomyDocumentation([command, './scenario.md', './extra.md'], { cwd: temporaryRoot }))
          .toThrow('at most one Markdown path')
        expect(() => readHolonomyDocumentation([command, './oversized.md'], { cwd: temporaryRoot }))
          .toThrow('exceeds the size limit')
        expect(() => readHolonomyDocumentation([command, './linked.md'], { cwd: temporaryRoot }))
          .toThrow('must not be a symbolic link')
        expect(() => readHolonomyDocumentation([command, './directory.md'], { cwd: temporaryRoot }))
          .toThrow('is not a file')
        expect(() => readHolonomyDocumentation([command, './invalid-utf8.md'], { cwd: temporaryRoot }))
          .toThrow('is not valid UTF-8 Markdown')
        expect(() => readHolonomyDocumentation([command, './missing.md'], { cwd: temporaryRoot }))
          .toThrow('is unavailable')
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  })
})
