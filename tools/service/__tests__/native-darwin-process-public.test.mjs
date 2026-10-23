import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import { HolonomyServiceClient } from '../service-client.mjs'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE
const absent = binary == null || process.platform !== 'darwin'
const cli = fileURLToPath(new URL('../../holonomy.mjs', import.meta.url))
const caseFile = fileURLToPath(
  new URL('../../../conformance/capabilities/process-native-darwin.test.mjs', import.meta.url)
)
const profileId = 'native-darwin-public'
const profile = {
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: { runtimeReadPaths: [], sandboxExecutablePath: '/usr/bin/sandbox-exec' }
  },
  defaultShellExecutableId: 'shell',
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [
    ['cat', '/bin/cat', false],
    ['echo', '/bin/echo', false],
    ['shell', '/bin/bash', true],
    ['sleep', '/bin/sleep', false]
  ].map(([executableId, path, shell]) => ({
    executable: { kind: 'hostPath', path },
    executableId,
    fixedArgs: [],
    shell
  })),
  profile: 'process-profile-v1'
}
const policy = {
  process: {
    access: 'sandboxed',
    environment: { allowedNames: ['HOLO_TEST_ENV'], maxValueBytes: 1024 },
    executables: profile.executables.map(item => ({ argumentBytes: 65_536, executableId: item.executableId })),
    limits: {
      maxConcurrentProcesses: 4,
      maxExecutionTimeMs: 15_000,
      maxOpenPipes: 12,
      maxProcessTreeDepth: 2,
      maxStderrBytes: 65_536,
      maxStdinBytes: 65_536,
      maxStdoutBytes: 65_536,
      maxTotalProcesses: 64,
      maxWritableRootfsBytes: 0
    },
    mounts: [],
    network: { access: 'none' },
    shell: { access: 'restricted', executableId: 'shell' }
  },
  schemaVersion: 2
}
const until = async (read, accepts) => {
  let latest
  for (let turn = 0; turn < 800; turn++) {
    latest = await read()
    if (accepts(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Native Process public operation did not settle: ${JSON.stringify(latest)}`)
}
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-process-public-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  await mkdir(home)
  await mkdir(project)
  const profiles = join(home, 'process-profiles.json')
  await writeFile(profiles, JSON.stringify({ profiles: { [profileId]: profile }, schemaVersion: 1 }), { mode: 0o600 })
  await writeFile(join(home, 'native-runtime.json'), JSON.stringify({ executablePath: binary, schemaVersion: 1 }), {
    mode: 0o600
  })
  await writeFile(
    join(project, 'host.json'),
    JSON.stringify({
      processProfileId: profileId,
      sandboxPolicy: policy,
      schemaVersion: 1
    })
  )
  await writeFile(
    join(project, 'capability.json'),
    JSON.stringify({
      context: {
        guest: { application: { id: 'native.process.public', name: 'Native Process' } },
        host: {},
        schemaVersion: 1
      },
      initialMiddlewareId: 'service.continue.v1',
      processProfileId: profileId,
      sandboxPolicy: policy,
      schemaVersion: 1
    })
  )
  await writeFile(join(project, 'case.mjs'), await readFile(caseFile, 'utf8'))
  const client = new HolonomyServiceClient({ home, environment: {} })
  const manager = createHolonomyServiceLifecycleManager({ client, home, service: { port: 0 } })
  return { root, home, project, profiles, client, manager }
}
const run = (executable, args, options) => {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = { stderr: '', stdout: '' }
  child.stdout.on('data', bytes => output.stdout += bytes)
  child.stderr.on('data', bytes => output.stderr += bytes)
  const completed = once(child, 'close')
  void completed.catch(() => undefined)
  return { child, completed, output }
}
const finish = async (running, timeout = 20_000) => {
  const timer = setTimeout(() => running.child.kill('SIGKILL'), timeout)
  try {
    const [code, signal] = await running.completed
    return { code, signal, ...running.output }
  } finally {
    clearTimeout(timer)
  }
}
const cliRun = (f, url, command, entry, extra = []) =>
  run(process.execPath, [
    cli,
    command,
    entry,
    '--target',
    'native',
    '--capability-runtime',
    'capability.json',
    '--openapi',
    `${url}/openapi.json`,
    '--openapi-token-file',
    join(f.home, 'token'),
    ...extra
  ], { cwd: f.project, env: { ...process.env, HOLONOMY_HOME: f.home } })
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
const cleanupOwnedMarker = (pid, marker) => {
  if (pid == null) return
  const observed = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (observed.status === 0 && observed.stdout.includes(marker)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

describe('public Native Darwin Process profile', () => {
  it.skipIf(absent)('runs one standard JS case unchanged in the standalone and Service Native runtimes', async () => {
    const f = await fixture()
    try {
      const direct = await finish(run(binary, [
        'test',
        '--timeout',
        '20000',
        '--host-config',
        'host.json',
        '--process-profiles',
        f.profiles,
        './case.mjs'
      ], { cwd: f.project, env: { PATH: '' } }))
      assert.equal(direct.code, 0, direct.stderr + direct.stdout)
      const directReport = JSON.parse(direct.stdout.trim())
      assert.equal(directReport.total, 3)
      assert.equal(directReport.passed, 3)
      assert.equal(directReport.failed, 0)
      const service = await f.manager.ensure()
      const result = await finish(cliRun(f, service.endpoint.baseUrl, 'test', './case.mjs', ['--reporter', 'json']))
      assert.equal(result.code, 0, result.stderr + result.stdout)
      const report = result.stdout.split('\n').map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).find(value => value?.total === 3 && Array.isArray(value.results))
      assert(report, result.stdout)
      assert.equal(report.passed, 3)
      assert.equal(report.failed, 0)
      const processes = await f.client.call('/v1/processes')
      assert.equal(processes.length, 1)
      const publicSnapshot = JSON.stringify(processes)
      for (
        const path of [
          ...profile.executables.map(item => item.executable.path),
          profile.backend.configuration.sandboxExecutablePath
        ]
      ) assert(!publicSnapshot.includes(path), path)
      const ended = processes[0]
      assert.equal(ended.exit?.code, 0, JSON.stringify(ended))
      await f.client.removeProcess(ended.id, ended.generation, 'native-process-conformance-remove')
    } finally {
      try {
        await f.manager.stop({ drain: true })
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    }
  }, 30_000)

  it.skipIf(absent)(
    'pins its private profile through plugin watch and cleans the active native workload on stop',
    async () => {
      const f = await fixture()
      const marker = `holo-native-owned-${randomUUID()}`
      let running
      let ownedPid
      try {
        await writeFile(
          join(f.project, 'permission.mjs'),
          "export default(c,o)=>{c.holo.intercept({operation:'process.program.spawn'},(i,next)=>o.deny?c.holo.deny(i):next(),{execution:'sync'})}"
        )
        const config = deny =>
          JSON.stringify({ plugins: [{ config: { deny }, id: 'process-permission', use: './permission.mjs' }] })
        await writeFile(join(f.project, 'holo.config.json'), config(false))
        await writeFile(
          join(f.project, 'watch.mjs'),
          [
            "import {spawn,execFileSync} from 'node:child_process';console.log('PROCESS_WATCH_ENTRY');",
            `const held=spawn('shell',['-c','printf "HELD_PID:%s\\n" "$$"; while :; do :; done',${
              JSON.stringify(marker)
            }]);`,
            "held.on('error',e=>{throw e});held.stdout.on('data',b=>console.log(b.toString('utf8')));",
            "setInterval(()=>{try{if(execFileSync('echo',['watch'],{encoding:'utf8'})!=='watch\\n')throw Error('bad output');",
            "console.log('PROCESS_WATCH_ALLOW')}catch(e){if(e.code!=='EACCES')throw e;console.log('PROCESS_WATCH_DENY')}},100)"
          ].join('\n')
        )
        const service = await f.manager.ensure()
        running = cliRun(f, service.endpoint.baseUrl, 'run', './watch.mjs', ['--config', 'holo.config.json', '--watch'])
        await until(
          () => running.output,
          value => value.stdout.includes('PROCESS_WATCH_ALLOW') && /HELD_PID:\d+/u.test(value.stdout)
        )
        ownedPid = Number(/HELD_PID:(\d+)/u.exec(running.output.stdout)[1])
        assert(alive(ownedPid))
        const [initial] = await f.client.call('/v1/processes')
        await writeFile(f.profiles, '{"schemaVersion":1,"profiles":{}}', { mode: 0o600 })
        await writeFile(join(f.project, 'holo.config.json'), config(true))
        await until(() => running.output, value => value.stdout.includes('PROCESS_WATCH_DENY'))
        await until(
          () => f.client.getProcess(initial.id),
          value => value.pluginGraphRevision === initial.pluginGraphRevision + 1
        )
        const allows = running.output.stdout.match(/PROCESS_WATCH_ALLOW/gu)?.length ?? 0
        await writeFile(join(f.project, 'holo.config.json'), config(false))
        await until(() => running.output.stdout, value => (value.match(/PROCESS_WATCH_ALLOW/gu)?.length ?? 0) > allows)
        const updated = await f.client.getProcess(initial.id)
        assert.equal(updated.pluginGraphRevision, initial.pluginGraphRevision + 2)
        assert.equal(updated.generation, initial.generation)
        assert.equal(running.output.stdout.match(/PROCESS_WATCH_ENTRY/gu)?.length, 1)
        assert(alive(ownedPid))
        running.child.kill('SIGINT')
        const result = await finish(running, 10_000)
        assert.equal(result.code, 130, result.stderr)
        const stoppedAt = Date.now()
        await until(
          () => ({ present: alive(ownedPid), elapsed: Date.now() - stoppedAt }),
          value => !value.present && value.elapsed < 2000
        )
      } finally {
        try {
          if (running != null && running.child.exitCode === null && running.child.signalCode === null) {
            running.child.kill('SIGKILL')
            await running.completed.catch(() => undefined)
          }
        } finally {
          try {
            await f.manager.stop({ drain: true })
          } finally {
            try {
              cleanupOwnedMarker(ownedPid, marker)
            } finally {
              await rm(f.root, { recursive: true, force: true })
            }
          }
        }
      }
    },
    30_000
  )
})
