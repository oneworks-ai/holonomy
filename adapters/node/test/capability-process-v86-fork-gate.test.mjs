import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'
import { V86 } from 'v86'

import { createV86ProbeLaunchV1 } from '../../../backends/v86/probe-real-launch.mjs'
import { createV86ProcessBackendV1 } from '../src/capability-process-v86-backend.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { assetRoot, entryUrl, moduleRootUrl, processProfileV1 } from './capability-process-v86-runtime-support.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

test('denies a fork-only shell command in the upgraded Linux image', {
  skip: assetRoot == null,
  timeout: 60_000
}, async t => {
  const profile = await processProfileV1(assetRoot)
  const backend = createV86ProcessBackendV1({
    V86,
    loadArtifact: artifact => readFile(path.join(assetRoot, artifact.artifactId)),
    readyTimeoutMs: 15_000
  })
  t.after(() => backend.closeGeneration(1))
  const launch = createV86ProbeLaunchV1({
    backend,
    configuration: backend.normalizeConfiguration(profile.backend.configuration),
    policy: {
      access: 'sandboxed',
      limits: { maxProcessTreeDepth: 1, maxTotalProcesses: 1 },
      mounts: [],
      network: { access: 'none' }
    }
  })
  const running = launch('shell', '/bin/sh', ['-c', '(printf A) & (printf B) & wait'])
  let stdout = ''
  let stderr = ''
  running.child.stdout.on('data', value => {
    stdout += value.toString()
  })
  running.child.stderr.on('data', value => {
    stderr += value.toString()
  })
  const terminal = await new Promise((resolve, reject) => {
    running.child.on('error', reject)
    running.child.on('close', (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(terminal, { code: 2, signal: null })
  assert.equal(stdout, '')
  assert.match(stderr, /can't fork: Operation not permitted/u)
})

test('denies same-PID execveat and every process-creation syscall in a test-only overlay', {
  skip: assetRoot == null || process.env.HOLO_V86_CONFORMANCE_IMAGE == null,
  timeout: 60_000
}, async t => {
  const files = {
    bios: path.join(assetRoot, 'seabios.bin'),
    initrd: process.env.HOLO_V86_CONFORMANCE_IMAGE,
    kernel: path.join(assetRoot, 'kernel.bin'),
    wasm: path.join(assetRoot, 'v86.wasm')
  }
  const values = new Map(
    await Promise.all(
      Object.entries(files).map(async ([key, file]) => [key, await readFile(file)])
    )
  )
  const artifact = key => ({
    artifactId: key,
    sha256: createHash('sha256').update(values.get(key)).digest('hex')
  })
  const backend = createV86ProcessBackendV1({
    V86,
    loadArtifact: input => values.get(input.artifactId),
    readyTimeoutMs: 15_000
  })
  t.after(() => backend.closeGeneration(1))
  const launch = createV86ProbeLaunchV1({
    backend,
    configuration: backend.normalizeConfiguration({
      artifacts: Object.fromEntries(Object.keys(files).map(key => [key, artifact(key)])),
      memoryBytes: 134_217_728,
      requiredKernelCapabilities: ['process'],
      supervisor: { protocolVersion: 1 }
    }),
    policy: {
      access: 'sandboxed',
      limits: { maxProcessTreeDepth: 1, maxTotalProcesses: 1 },
      mounts: [],
      network: { access: 'none' }
    }
  })
  const running = launch('selftest', '/usr/bin/holo-v86-selftest', ['execveat-denied'])
  let stdout = ''
  running.child.stdout.on('data', value => {
    stdout += value.toString()
  })
  const terminal = await new Promise((resolve, reject) => {
    running.child.on('error', reject)
    running.child.on('close', (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(terminal, { code: 0, signal: null })
  assert.equal(stdout, 'EXECVEAT_DIRECT_DENIED\n')
  const creation = launch('creation', '/usr/bin/holo-v86-selftest', ['creation-denied'])
  let creationOutput = ''
  creation.child.stdout.on('data', value => {
    creationOutput += value.toString()
  })
  const creationTerminal = await new Promise((resolve, reject) => {
    creation.child.on('error', reject)
    creation.child.on('close', (code, signal) => resolve({ code, signal }))
  })
  assert.deepEqual(creationTerminal, { code: 0, signal: null })
  assert.equal(creationOutput, 'FORK_DENIED\nVFORK_DENIED\nCLONE_DENIED\nCLONE3_DENIED\n')
})

test('runs the upgraded v86 image through Node Runtime and rejects fork-only descendants', {
  skip: assetRoot == null,
  timeout: 75_000
}, async t => {
  const hostPath = await mkdtemp(path.join(os.tmpdir(), 'holo-v86-fork-gate-'))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 60_000 })
  t.after(async () => {
    await supervisor.stop()
    await rm(hostPath, { force: true, recursive: true })
  })
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  supervisor.on('state', event => logs.push(`state:${event.state}`))
  supervisor.on('fatal', event => logs.push(`fatal:${event.code}`))
  const processProfile = await processProfileV1(assetRoot)
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath,
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processLimits: {
      maxExecutionTimeMs: 60_000,
      maxTotalProcesses: 64
    },
    processMounts: [{ guestPath: '/workspace', rights: ['read', 'write'], rootId: 'workspace' }],
    processProfile,
    source: `
      import { execFile, spawn } from 'node:child_process'
      try {
        new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
        throw new Error('Guest WebAssembly unexpectedly compiled')
      } catch (error) {
        if (error.name !== 'CompileError') throw error
      }
      const run = (id, args, input) => new Promise((resolve, reject) => {
        const child = spawn(id, args)
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', value => { stdout += new TextDecoder().decode(value) })
        child.stderr.on('data', value => { stderr += new TextDecoder().decode(value) })
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout }))
        if (input != null) child.stdin.write(input)
        child.stdin.end()
      })
      const cat = await run('cat', [], 'NODE_V86_CAT_OK')
      const shell = await run('shell', ['-c', 'printf NODE_V86_SHELL_OK'])
      const fork = await run('shell', ['-c', '(printf A) & (printf B) & wait'])
      const deniedExec = await new Promise(resolve => execFile('shell',
        ['-c', 'exec /bin/cat /dev/null'], { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ code: error?.code, stderr, stdout })))
      if (cat.code !== 0 || cat.stdout !== 'NODE_V86_CAT_OK' || cat.stderr !== '') {
        throw new Error('cat did not complete')
      }
      if (shell.code !== 0 || shell.stdout !== 'NODE_V86_SHELL_OK' || shell.stderr !== '') {
        throw new Error('single-process shell did not complete')
      }
      if (fork.code === 0 || fork.stdout.includes('AB') || !fork.stderr.includes('Operation not permitted')) {
        throw new Error('fork-only descendant bypassed the Guest gate')
      }
      console.log('NODE_V86_DENIED_CODE:' + deniedExec.code)
      if (deniedExec.code !== 126 || deniedExec.stdout !== '' ||
          !deniedExec.stderr.includes('Operation not permitted')) {
        throw new Error('later Guest exec result mismatch: ' + deniedExec.code)
      }
      console.log('NODE_V86_FORK_GATE_OK')
    `
  })
  try {
    await supervisor.start(session)
  } catch (error) {
    throw new Error(`v86 fork-gate Runtime failed: ${String(error)}\n${logs.join('\n')}`, { cause: error })
  }
  assert.ok(logs.includes('NODE_V86_FORK_GATE_OK'), logs.join('\n'))
})
