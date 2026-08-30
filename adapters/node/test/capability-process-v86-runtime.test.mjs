import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

const assetRoot = process.env.HOLO_V86_PRODUCTION_ASSET_ROOT
const entryUrl = 'app+local://workspace/main.mjs'
const moduleRootUrl = 'app+local://workspace/'

const profile = async root => {
  const files = {
    bios: 'seabios.bin',
    initrd: 'agent.cpio',
    kernel: 'kernel.bin',
    wasm: 'v86.wasm'
  }
  const artifacts = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([key, artifactId]) => [
        key,
        {
          artifactId,
          sha256: createHash('sha256').update(await readFile(path.join(root, artifactId))).digest('hex')
        }
      ])
    )
  )
  return {
    backend: {
      backendId: 'experimental.v86-v1',
      configuration: {
        artifacts,
        memoryBytes: 128 * 1024 * 1024,
        requiredKernelCapabilities: ['process', 'fuse', 'seccompUserNotification'],
        supervisor: { protocolVersion: 1 }
      }
    },
    environment: {
      allowedScopes: ['processTree'],
      capabilityBridge: { domains: ['device', 'system'] },
      defaultScope: 'processTree'
    },
    executables: [
      {
        executable: { kind: 'guestPath', path: '/bin/sh' },
        executableId: 'shell',
        fixedArgs: [],
        shell: true
      },
      {
        executable: { kind: 'guestPath', path: '/bin/cat' },
        executableId: 'cat',
        fixedArgs: [],
        shell: false
      },
      {
        executable: { kind: 'guestPath', path: '/usr/bin/curl' },
        executableId: 'curl',
        fixedArgs: [],
        shell: false
      },
      {
        executable: { kind: 'guestPath', path: '/usr/bin/hoholo' },
        executableId: 'hoholo',
        fixedArgs: [],
        shell: false
      },
      {
        executable: { kind: 'guestPath', path: '/usr/bin/nc' },
        executableId: 'nc',
        fixedArgs: [],
        shell: false
      },
      ...[
        ['ls', '/bin/ls'],
        ['mkdir', '/bin/mkdir'],
        ['mv', '/bin/mv'],
        ['rm', '/bin/rm'],
        ['rmdir', '/bin/rmdir'],
        ['timeout', '/usr/bin/timeout']
      ].map(([executableId, executablePath]) => ({
        executable: { kind: 'guestPath', path: executablePath },
        executableId,
        fixedArgs: [],
        shell: false
      }))
    ],
    profile: 'process-profile-v1'
  }
}

test('runs the installed v86 Backend through the production Node Runtime path', {
  skip: assetRoot == null,
  timeout: 90_000
}, async t => {
  const processProfile = await profile(assetRoot)
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-runtime-'))
  const hostAddress = Object.values(os.networkInterfaces()).flat().find(
    value => value?.family === 'IPv4' && !value.internal
  )?.address
  const hostName = os.hostname().toLowerCase()
  assert.ok(hostAddress, 'v86 raw TCP E2E requires a Host IPv4 interface')
  await writeFile(path.join(filesystemRoot, 'input.txt'), 'HOST_TO_GUEST')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('HOLO_V86_NETWORK_OK')
  })
  server.listen({ port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address != null && typeof address === 'object')
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 75_000 })
  t.after(async () => {
    await supervisor.stop()
    server.close()
    await rm(filesystemRoot, { force: true, recursive: true })
  })
  const logs = []
  supervisor.on('log', event => logs.push(event.text))

  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: filesystemRoot,
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processLimits: { maxExecutionTimeMs: 60_000, maxTotalProcesses: 64 },
    processMounts: [{ guestPath: '/workspace', rights: ['read', 'write'], rootId: 'workspace' }],
    processNetwork: {
      access: 'restricted',
      endpoints: [
        { hostname: '127.0.0.1', ports: [address.port], transport: 'tcp' },
        { hostname: hostAddress, ports: [address.port], transport: 'tcp' },
        { hostname: hostName, ports: [address.port], transport: 'tcp' }
      ],
      maxSockets: 1
    },
    processProfile,
    source: `
      import { spawn } from 'node:child_process'
      const run = (executableId, args, input) => new Promise((resolve, reject) => {
          const child = spawn(executableId, args)
          const stdout = []
          const stderr = []
          child.stdout.on('data', chunk => stdout.push(...chunk))
          child.stderr.on('data', chunk => stderr.push(...chunk))
          child.on('error', error => {
            console.log('V86_CHILD_ERROR:' + JSON.stringify({
              code: error.code,
              executableId,
              message: error.message,
              name: error.name,
            }))
            reject(error)
          })
          child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout }))
          if (input != null) child.stdin.write(input)
          child.stdin.end()
        })
      const stage = value => console.log('V86_PRODUCTION_STAGE:' + value)
      stage('stdio')
      const stdio = await run('shell', [
        '-c',
        'IFS= read -r line; printf "REAL_STDOUT:%s\\\\n" "$line"; printf "REAL_STDERR\\\\n" >&2; exit 7',
      ], 'host-input\\n')
      stage('filesystem')
      const filesystem = await run('shell', [
        '-c',
        'printf "FUSE_INPUT:"; /bin/cat /workspace/input.txt; printf GUEST_TO_HOST > /workspace/output.txt',
      ])
      stage('filesystem-surface')
      const filesystemSurface = await run('shell', [
        '-c',
        '/bin/mkdir /workspace/subdir && printf DIRECTORY_OK > /workspace/subdir/source.txt && ' +
          '/bin/ls /workspace/subdir && /bin/mv /workspace/subdir/source.txt /workspace/subdir/target.txt && ' +
          '/bin/cat /workspace/subdir/target.txt && /bin/rm /workspace/subdir/target.txt && ' +
          '/bin/rmdir /workspace/subdir',
      ])
      stage('identity')
      const identity = await run('shell', ['-c', '/bin/cat /proc/self/status'])
      stage('hosts')
      const hosts = await run('shell', ['-c', '/bin/cat /etc/hosts'])
      stage('network-proxy')
      const network = await run('curl', [
        '--fail', '--silent', '--show-error', '--noproxy', '',
        '--proxy', 'http://192.168.86.1:80',
        'http://127.0.0.1:${address.port}/v86',
      ])
      stage('network-state')
      const networkState = await run('shell', [
        '-c', '/bin/cat /proc/net/dev; /bin/cat /proc/net/route',
      ])
      stage('network-address')
      const rawTcp = await run('curl', [
        '--fail', '--silent', '--show-error', '--noproxy', '*',
        'http://${hostAddress}:${address.port}/raw',
      ])
      stage('network-hostname')
      const hostnameTcp = await run('curl', [
        '--fail', '--silent', '--show-error', '--noproxy', '*',
        'http://${hostName}:${address.port}/hostname',
      ])
      stage('descendant')
      const descendant = await run('shell', [
        '-c',
        '/bin/cat /dev/null && printf "DESCENDANT_ALLOWED\\\\n"',
      ])
      stage('relative-exec')
      const relativeExec = await run('shell', [
        '-c',
        'cd /bin; if ./cat /dev/null 2>/dev/null; then exit 92; else printf "RELATIVE_EXEC_DENIED\\\\n"; fi',
      ])
      stage('device')
      const device = await run('hoholo', ['device', 'summary'])
      stage('system')
      const system = await run('hoholo', ['system', 'read', 'os.arch'])
      console.log('V86_PRODUCTION_RUNTIME:' + JSON.stringify({
        descendant, device, filesystem, filesystemSurface, hostnameTcp, hosts, identity, network, networkState,
        rawTcp, relativeExec, stdio, system,
      }))
    `
  })
  try {
    await supervisor.start(session)
  } catch (error) {
    throw new Error(`v86 production Runtime failed\n${logs.join('\n')}`, { cause: error })
  }

  const line = logs.find(value => value.startsWith('V86_PRODUCTION_RUNTIME:'))
  assert.ok(line)
  const result = JSON.parse(line.slice(23))
  assert.deepEqual(result.descendant, {
    code: 0,
    signal: null,
    stderr: [],
    stdout: [...Buffer.from('DESCENDANT_ALLOWED\n')]
  })
  assert.deepEqual(result.relativeExec, {
    code: 0,
    signal: null,
    stderr: [],
    stdout: [...Buffer.from('RELATIVE_EXEC_DENIED\n')]
  })
  assert.deepEqual(result.stdio, {
    code: 7,
    signal: null,
    stderr: [...Buffer.from('REAL_STDERR\n')],
    stdout: [...Buffer.from('REAL_STDOUT:host-input\n')]
  })
  assert.equal(result.device.code, 0, Buffer.from(result.device.stderr).toString())
  const device = JSON.parse(Buffer.from(result.device.stdout).toString())
  assert.equal(device.schemaVersion, 1)
  assert.equal(device.formFactor.status, 'available')
  assert.equal(device.formFactor.value, 'server')
  assert.equal(result.system.code, 0, Buffer.from(result.system.stderr).toString())
  assert.equal(JSON.parse(Buffer.from(result.system.stdout).toString()), 'arm64')
  assert.deepEqual(result.filesystem, {
    code: 0,
    signal: null,
    stderr: [],
    stdout: [...Buffer.from('FUSE_INPUT:HOST_TO_GUEST')]
  })
  assert.deepEqual(result.filesystemSurface, {
    code: 0,
    signal: null,
    stderr: [],
    stdout: [...Buffer.from('source.txt\nDIRECTORY_OK')]
  })
  assert.equal(result.identity.code, 0)
  assert.match(Buffer.from(result.identity.stdout).toString(), /^Uid:\s+1000\s+1000\s+1000\s+1000$/mu)
  assert.equal(Buffer.from(await readFile(path.join(filesystemRoot, 'output.txt'))).toString(), 'GUEST_TO_HOST')
  assert.equal(result.network.code, 0, Buffer.from(result.network.stderr).toString())
  assert.equal(result.network.signal, null)
  assert.deepEqual(result.network.stderr, [])
  assert.match(Buffer.from(result.network.stdout).toString(), /HOLO_V86_NETWORK_OK/u)
  assert.equal(result.networkState.code, 0)
  assert.match(Buffer.from(result.networkState.stdout).toString(), /eth0/u)
  assert.match(Buffer.from(result.networkState.stdout).toString(), /eth0\t00000000\t0156A8C0/u)
  assert.equal(
    result.rawTcp.code,
    0,
    `${Buffer.from(result.rawTcp.stderr).toString()}\nnetwork-state=${
      JSON.stringify({
        code: result.networkState.code,
        stderr: Buffer.from(result.networkState.stderr).toString(),
        stdout: Buffer.from(result.networkState.stdout).toString()
      })
    }`
  )
  assert.equal(result.rawTcp.signal, null)
  assert.deepEqual(result.rawTcp.stderr, [])
  assert.match(Buffer.from(result.rawTcp.stdout).toString(), /HOLO_V86_NETWORK_OK/u)
  assert.equal(
    result.hostnameTcp.code,
    0,
    JSON.stringify({
      hosts: Buffer.from(result.hosts.stdout).toString(),
      stderr: Buffer.from(result.hostnameTcp.stderr).toString()
    })
  )
  assert.equal(result.hostnameTcp.signal, null)
  assert.deepEqual(result.hostnameTcp.stderr, [])
  assert.match(Buffer.from(result.hostnameTcp.stdout).toString(), /HOLO_V86_NETWORK_OK/u)
})

test('bridges a Linux UDP datagram through the production Process Network authority', {
  skip: assetRoot == null,
  timeout: 45_000
}, async t => {
  const processProfile = await profile(assetRoot)
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-udp-'))
  const hostAddress = Object.values(os.networkInterfaces()).flat().find(
    value => value?.family === 'IPv4' && !value.internal
  )?.address
  assert.ok(hostAddress, 'v86 UDP E2E requires a Host IPv4 interface')
  const server = createSocket('udp4')
  server.on('message', (message, remote) => {
    server.send(Buffer.concat([Buffer.from('HOLO_V86_UDP_OK:'), message]), remote.port, remote.address)
  })
  server.bind(0)
  await once(server, 'listening')
  const address = server.address()
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 30_000 })
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  t.after(async () => {
    await supervisor.stop()
    server.close()
    await rm(filesystemRoot, { force: true, recursive: true })
  })
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: filesystemRoot,
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processLimits: { maxExecutionTimeMs: 10_000 },
    processNetwork: {
      access: 'restricted',
      endpoints: [{ hostname: hostAddress, ports: [address.port], transport: 'udp' }],
      maxSockets: 1
    },
    processProfile,
    source: `
      import { spawn } from 'node:child_process'
      const result = await new Promise((resolve, reject) => {
        const child = spawn('timeout', [
          '5', '/usr/bin/nc', '-u', '-w', '2', '${hostAddress}', '${address.port}',
        ])
        const stdout = []
        const stderr = []
        child.stdout.on('data', chunk => stdout.push(...chunk))
        child.stderr.on('data', chunk => stderr.push(...chunk))
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout }))
        child.stdin.write('guest-datagram')
        child.stdin.end()
      })
      console.log('V86_UDP_RUNTIME:' + JSON.stringify(result))
    `
  })
  try {
    await supervisor.start(session)
  } catch (error) {
    throw new Error(`v86 UDP Runtime failed\n${String(error?.stack ?? error)}\n${logs.join('\n')}`, { cause: error })
  }
  const line = logs.find(value => value.startsWith('V86_UDP_RUNTIME:'))
  assert.ok(line)
  const result = JSON.parse(line.slice(16))
  assert.equal(result.code, 0, Buffer.from(result.stderr).toString())
  assert.equal(result.signal, null)
  assert.equal(Buffer.from(result.stdout).toString(), 'HOLO_V86_UDP_OK:guest-datagram')
})

test('denies a v86 descendant exec through Host middleware without killing the environment', {
  skip: assetRoot == null,
  timeout: 90_000
}, async t => {
  const processProfile = await profile(assetRoot)
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-descendant-deny-'))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 75_000 })
  t.after(async () => {
    await supervisor.stop()
    await rm(filesystemRoot, { force: true, recursive: true })
  })
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const session = capabilityRuntimeSession({
    behavior: 'deny',
    entryUrl,
    hostPath: filesystemRoot,
    middlewareMatcher: { member: 'authorizeDescendantProcess' },
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processLimits: { maxExecutionTimeMs: 60_000 },
    processProfile,
    source: `
      import { spawn } from 'node:child_process'
      const result = await new Promise((resolve, reject) => {
        const child = spawn('shell', [
          '-c',
          'if /bin/cat /dev/null; then exit 91; else printf "DESCENDANT_HOST_DENIED\\\\n"; fi',
        ])
        const stdout = []
        child.stdout.on('data', chunk => stdout.push(...chunk))
        child.on('error', error => {
          console.log('V86_CHILD_ERROR:' + JSON.stringify({
            code: error.code,
            message: error.message,
            name: error.name,
          }))
          reject(error)
        })
        child.on('close', (code, signal) => resolve({ code, signal, stdout }))
      })
      console.log('V86_DESCENDANT_DENY:' + JSON.stringify(result))
    `
  })
  try {
    await supervisor.start(session)
  } catch (error) {
    throw new Error(`v86 descendant denial failed\n${logs.join('\n')}`, { cause: error })
  }
  const line = logs.find(value => value.startsWith('V86_DESCENDANT_DENY:'))
  assert.ok(line)
  assert.deepEqual(JSON.parse(line.slice(20)), {
    code: 0,
    signal: null,
    stdout: [...Buffer.from('DESCENDANT_HOST_DENIED\n')]
  })
})

test('rejects a tampered installed v86 artifact before Guest entry', {
  skip: assetRoot == null
}, async () => {
  const processProfile = await profile(assetRoot)
  processProfile.backend.configuration.artifacts.kernel.sha256 = '0'.repeat(64)
  const supervisor = new NodeRuntimeSupervisor()
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  const session = capabilityRuntimeSession({
    entryUrl,
    hostPath: assetRoot,
    moduleRootUrl,
    processBackendInstallation: {
      artifactRoot: assetRoot,
      backendId: 'experimental.v86-v1',
      implementation: 'builtin.v86-v1'
    },
    processProfile,
    source: `console.log('TAMPERED_V86_GUEST_ENTRY')`
  })

  await assert.rejects(supervisor.start(session), TypeError)
  assert.equal(supervisor.generation, 0)
  assert.equal(logs.some(value => value.includes('TAMPERED_V86_GUEST_ENTRY')), false)
})
