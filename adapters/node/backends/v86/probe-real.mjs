import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { createV86ProcessBackendV1 } from '../../src/capability-process-v86-backend.mjs'
import { createV86FuseBrokerProbeV1 } from './probe-fuse-broker.mjs'
import { createV86FuseMemoryProbeV1 } from './probe-fuse-memory.mjs'

const usage = () => {
  throw new TypeError(
    'Usage: node probe-real.mjs <libv86.mjs> <v86.wasm> <seabios.bin> <kernel> <supervisor-initrd>'
  )
}

const main = async () => {
  const paths = process.argv.slice(2)
  if (paths.length !== 5) usage()

  const [modulePath, wasmPath, biosPath, kernelPath, initrdPath] = paths
  const { V86: ImportedV86 } = await import(pathToFileURL(modulePath).href)
  const values = new Map(
    await Promise.all(
      [
        ['wasm', wasmPath],
        ['bios', biosPath],
        ['kernel', kernelPath],
        ['initrd', initrdPath]
      ].map(async ([artifactId, filePath]) => [artifactId, await readFile(filePath)])
    )
  )
  const artifact = artifactId => ({
    artifactId,
    sha256: createHash('sha256').update(values.get(artifactId)).digest('hex')
  })

  let serial0Tail = ''
  class ProbeV86 extends ImportedV86 {
    constructor(options) {
      super(options)
      this.add_listener('serial0-output-byte', byte => {
        const value = String.fromCharCode(byte)
        serial0Tail = (serial0Tail + value).slice(-16_384)
        if (process.env.HOLO_V86_TRACE === '1') process.stderr.write(value)
      })
      if (process.env.HOLO_V86_TRACE === '1') {
        this.add_listener('serial1-output-byte', byte => {
          process.stderr.write(byte.toString(16).padStart(2, '0'))
        })
        for (const event of ['emulator-ready', 'emulator-started', 'download-error']) {
          this.add_listener(event, () => process.stderr.write(`[v86:${event}]\n`))
        }
      }
    }
  }

  let supervisorKernelCapabilities = []
  const fuseRoot = process.env.HOLO_V86_BROKER_FS === '1'
    ? await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-fuse-broker-'))
    : undefined
  const fuse = fuseRoot == null
    ? createV86FuseMemoryProbeV1()
    : await createV86FuseBrokerProbeV1(fuseRoot)
  const backend = createV86ProcessBackendV1({
    V86: ProbeV86,
    loadArtifact: input => values.get(input.artifactId),
    handleFilesystemRequest: fuse.handleFilesystemRequest,
    onKernelCapabilities: value => {
      supervisorKernelCapabilities = value
    },
    readyTimeoutMs: 60_000
  })
  const requiredKernelCapabilities = process.env.HOLO_V86_REQUIRED_KERNEL_CAPABILITIES == null
    ? ['process']
    : process.env.HOLO_V86_REQUIRED_KERNEL_CAPABILITIES.split(',')
  const configuration = backend.normalizeConfiguration({
    artifacts: {
      bios: artifact('bios'),
      initrd: artifact('initrd'),
      kernel: artifact('kernel'),
      wasm: artifact('wasm')
    },
    memoryBytes: 128 * 1024 * 1024,
    requiredKernelCapabilities,
    supervisor: { protocolVersion: 1 }
  })

  const launch = (resourceId, executablePath, runtimeArgs) =>
    backend.spawn(
      backend.prepareLaunch({
        configuration,
        environmentScope: 'processTree',
        executable: backend.normalizeExecutable({ kind: 'guestPath', path: executablePath }),
        executableId: resourceId,
        generation: 1,
        policy: fuse.policy ?? { access: 'sandboxed' },
        runtimeArgs
      }),
      { cwd: '/', env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] },
      { processResourceId: resourceId }
    )

  try {
    if (process.env.HOLO_V86_HANDSHAKE_ONLY === '1') {
      const missing = launch('v86-real-handshake', '/holo-missing-workload', [])
      const [missingCode, missingSignal] = await once(missing.child, 'close')
      assert.equal(missingCode, 127)
      assert.equal(missingSignal, null)
      process.stdout.write(`${
        JSON.stringify({
          backendId: backend.descriptor.backendId,
          missingCode,
          supervisorKernelCapabilities,
          verified: true
        })
      }\n`)
      return
    }
    const running = launch(
      'v86-real-stdio',
      '/holo-selftest',
      ['stdio-exit']
    )
    const stdout = []
    const stderr = []
    const errors = []
    running.child.stdout.on('data', value => stdout.push(value))
    running.child.stderr.on('data', value => stderr.push(value))
    running.child.on('error', error => errors.push(error))
    running.child.stdin.end('host-input\n')
    const [code, signal] = await once(running.child, 'close')
    const output = Buffer.concat(stdout).toString()
    const diagnostic = Buffer.concat(stderr).toString()
    assert.deepEqual(errors, [])
    assert.equal(code, 7)
    assert.equal(signal, null)
    assert.equal(output, 'REAL_STDOUT:host-input\n')
    assert.equal(diagnostic, 'REAL_STDERR\n')

    const signalled = launch('v86-real-signal', '/holo-selftest', ['sleep'])
    await once(signalled.child, 'spawn')
    signalled.killTree('SIGTERM')
    const [signalCode, signalName] = await once(signalled.child, 'close')
    assert.equal(signalCode, null)
    assert.equal(signalName, 'SIGTERM')

    const fuseProcess = launch('v86-real-fuse', '/holo-selftest', ['fuse'])
    const fuseOutput = []
    fuseProcess.child.stdout.on('data', value => fuseOutput.push(value))
    const [fuseCode] = await once(fuseProcess.child, 'close')
    assert.equal(fuseCode, 0)
    assert.equal(Buffer.concat(fuseOutput).toString(), 'FUSE_INPUT:HOST_TO_GUEST')
    assert.equal(Buffer.from(await fuse.readFile('/workspace/output.txt')).toString(), 'GUEST_TO_HOST')
    const attributed = (event, operations) =>
      operations.includes(event.operation) && (event.processId ?? event.syntheticProcessId) !== 0
    assert.ok(fuse.events.some(event => attributed(event, ['read', 'filesystem.file.read'])))
    assert.ok(fuse.events.some(event => attributed(event, ['write', 'filesystem.file.write'])))
    assert.equal(backend.descriptor.features.filesystemBridge, fuseRoot != null)

    assert.deepEqual(supervisorKernelCapabilities, requiredKernelCapabilities)
    process.stdout.write(`${
      JSON.stringify({
        backendId: backend.descriptor.backendId,
        code,
        fuseEvents: fuse.events.length,
        filesystemBridge: backend.descriptor.features.filesystemBridge,
        fuseMode: fuseRoot == null ? 'memory' : 'broker',
        signal: signalName,
        stderr: diagnostic,
        stdout: output,
        supervisorKernelCapabilities,
        verified: true
      })
    }\n`)
  } catch (error) {
    process.stderr.write(`${serial0Tail}\n`)
    throw error
  } finally {
    await backend.closeGeneration(1)
    fuse.close?.()
    if (fuseRoot != null) await rm(fuseRoot, { force: true, recursive: true })
  }
}

void main()
