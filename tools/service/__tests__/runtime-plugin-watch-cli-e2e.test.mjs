import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'vitest'

import { createHolonomyService } from '../server.mjs'
import { createHolonomyServiceClient } from '../service-client.mjs'

const token = 'plugin-watch-cli-token-at-least-thirty-two-bytes'
const nativeProcessProfile = {
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: {
      runtimeReadPaths: ['/opt/homebrew'],
      sandboxExecutablePath: '/usr/bin/sandbox-exec'
    }
  },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executableId: 'node-helper',
    executablePath: process.execPath,
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
}

const config = deny =>
  JSON.stringify({
    plugins: [{ config: { deny }, id: 'permission', use: './permission.mjs' }]
  })

const capabilityRuntime = () => ({
  context: { schemaVersion: 1 },
  initialMiddlewareId: 'service.continue.v1',
  ...(process.platform === 'darwin' ? { processProfileId: 'developer' } : {}),
  sandboxPolicy: {
    device: {
      defaultAccess: 'deny',
      maxEventsPerSecond: 1,
      maxQueuedEvents: 0,
      maxSubscriptions: 0,
      operations: {}
    },
    filesystem: { access: 'none' },
    ...(process.platform === 'darwin'
      ? {
        process: {
          access: 'sandboxed',
          environment: { allowedNames: [], maxValueBytes: 1024 },
          executables: [{ argumentBytes: 64 * 1024, executableId: 'node-helper' }],
          limits: {
            maxConcurrentProcesses: 1,
            maxExecutionTimeMs: 5000,
            maxOpenPipes: 3,
            maxProcessTreeDepth: 1,
            maxStderrBytes: 64 * 1024,
            maxStdinBytes: 64 * 1024,
            maxStdoutBytes: 64 * 1024,
            maxTotalProcesses: 1,
            maxWritableRootfsBytes: 0
          },
          mounts: [],
          network: { access: 'none' },
          shell: { access: 'none' }
        }
      }
      : {}),
    schemaVersion: 2,
    systemInformation: {
      defaultMode: 'unavailable',
      fields: { 'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' } }
    }
  },
  schemaVersion: 1
})

const waitForOutput = async (read, value) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const output = read()
    if (output.includes(value)) return output
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`Timed out waiting for CLI output: ${value}\n${read()}`)
}

const waitFor = async predicate => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('Timed out waiting for CLI Runtime cleanup')
}

describe('holonomy run --watch process integration', () => {
  it('reloads a real Service plugin graph and retains the last-known-good revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-plugin-watch-cli-'))
    const configPath = join(directory, 'holo.config.json')
    const runtimePath = join(directory, 'capability-runtime.json')
    const tokenPath = join(directory, 'service.token')
    const service = createHolonomyService({
      ...(process.platform === 'darwin' ? { capabilityProcessProfiles: { developer: nativeProcessProfile } } : {}),
      port: 0,
      stateDirectory: join(directory, 'state'),
      token
    })
    let child
    let stdout = ''
    let stderr = ''
    try {
      await Promise.all([
        writeFile(
          join(directory, 'entry.mjs'),
          `import { arch } from 'node:os'
          ${
            process.platform === 'darwin'
              ? `import { execFileSync } from 'node:child_process'
          console.log('CLI_CHILD:' + execFileSync(
            'node-helper', ['-e', 'process.stdout.write("native-child-ok")'], { encoding: 'utf8' }
          ))`
              : ''
          }
          console.log('CLI_WATCH_ARCH:' + arch())`
        ),
        writeFile(
          join(directory, 'permission.mjs'),
          `import { createHoloPermissionPluginV1 } from '@holonomyjs/plugin-permission'
          export default createHoloPermissionPluginV1({
            decide: ({ pluginConfig }) => pluginConfig.deny ? 'deny' : 'allow',
            execution: 'sync',
            matcher: { operation: 'system.os.arch.read' }
          })`
        ),
        writeFile(configPath, config(false)),
        writeFile(runtimePath, JSON.stringify(capabilityRuntime())),
        writeFile(tokenPath, token, { mode: 0o600 })
      ])
      await service.start()
      child = spawn(process.execPath, [
        resolve('tools/holonomy.mjs'),
        'run',
        '--target',
        'node',
        '--config',
        configPath,
        '--watch',
        '--capability-runtime',
        runtimePath,
        '--openapi',
        service.baseUrl,
        '--openapi-token-file',
        tokenPath,
        'entry.mjs'
      ], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        stdout += chunk
      })
      child.stderr.on('data', chunk => {
        stderr += chunk
      })

      try {
        await waitForOutput(() => stdout + stderr, 'CLI_WATCH_ARCH:')
      } catch (error) {
        const client = createHolonomyServiceClient({ baseUrl: service.baseUrl, token })
        const processes = await client.call('/v1/processes')
        const logs = await Promise.all(processes.map(process => client.readLogs(process.id, { limit: 512 })))
        throw new Error(`${error.message}\n${JSON.stringify({ logs, processes })}`, { cause: error })
      }
      if (process.platform === 'darwin') {
        await waitForOutput(() => stdout + stderr, 'CLI_CHILD:native-child-ok')
      }
      await writeFile(configPath, config(true))
      await waitForOutput(() => stdout + stderr, 'Runtime plugin graph updated to revision 2')

      await writeFile(configPath, '{"plugins":[')
      await waitForOutput(() => stdout + stderr, 'revision 2 remains active; candidate was rejected')

      await writeFile(configPath, config(false))
      await waitForOutput(() => stdout + stderr, 'Runtime plugin graph updated to revision 3')
    } finally {
      if (child != null && child.exitCode == null && child.signalCode == null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await Promise.race([
          exited,
          new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not exit after SIGTERM')), 5000))
        ])
      }
      if (service.baseUrl != null) {
        const client = createHolonomyServiceClient({ baseUrl: service.baseUrl, token })
        await waitFor(async () => (await client.call('/v1/processes')).length === 0)
      }
      await service.close()
      await rm(directory, { force: true, recursive: true })
    }
  }, 30_000)
})
