import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
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
    initrd: 'supervisor.cpio',
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
        requiredKernelCapabilities: ['process', 'fuse'],
        supervisor: { protocolVersion: 1 }
      }
    },
    environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
    executables: [{
      executable: { kind: 'guestPath', path: '/holo-selftest' },
      executableId: 'selftest',
      fixedArgs: [],
      shell: false
    }],
    profile: 'process-profile-v1'
  }
}

test('runs the installed v86 Backend through the production Node Runtime path', {
  skip: assetRoot == null,
  timeout: 90_000
}, async t => {
  const processProfile = await profile(assetRoot)
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-runtime-'))
  await writeFile(path.join(filesystemRoot, 'input.txt'), 'HOST_TO_GUEST')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('HOLO_V86_NETWORK_OK')
  })
  server.listen({ host: '127.0.0.1', port: 0 })
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
    processLimits: { maxExecutionTimeMs: 60_000 },
    processMounts: [{ guestPath: '/workspace', rights: ['read', 'write'], rootId: 'workspace' }],
    processNetwork: {
      access: 'restricted',
      endpoints: [{ hostname: '127.0.0.1', ports: [address.port], transport: 'tcp' }],
      maxSockets: 1
    },
    processProfile,
    source: `
      import { spawn } from 'node:child_process'
      const run = (args, input) => new Promise((resolve, reject) => {
          const child = spawn('selftest', args)
          const stdout = []
          const stderr = []
          child.stdout.on('data', chunk => stdout.push(...chunk))
          child.stderr.on('data', chunk => stderr.push(...chunk))
          child.on('error', reject)
          child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout }))
          if (input != null) child.stdin.write(input)
          child.stdin.end()
        })
      const stdio = await run(['stdio-exit'], 'host-input\\n')
      const filesystem = await run(['fuse'])
      const network = await run(['network', '${address.port}'])
      console.log('V86_PRODUCTION_RUNTIME:' + JSON.stringify({ filesystem, network, stdio }))
    `
  })
  await supervisor.start(session)

  const line = logs.find(value => value.startsWith('V86_PRODUCTION_RUNTIME:'))
  assert.ok(line)
  const result = JSON.parse(line.slice(23))
  assert.deepEqual(result.stdio, {
    code: 7,
    signal: null,
    stderr: [...Buffer.from('REAL_STDERR\n')],
    stdout: [...Buffer.from('REAL_STDOUT:host-input\n')]
  })
  assert.deepEqual(result.filesystem, {
    code: 0,
    signal: null,
    stderr: [],
    stdout: [...Buffer.from('FUSE_INPUT:HOST_TO_GUEST')]
  })
  assert.equal(Buffer.from(await readFile(path.join(filesystemRoot, 'output.txt'))).toString(), 'GUEST_TO_HOST')
  assert.equal(result.network.code, 0)
  assert.equal(result.network.signal, null)
  assert.deepEqual(result.network.stderr, [])
  assert.match(Buffer.from(result.network.stdout).toString(), /HOLO_V86_NETWORK_OK/u)
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
