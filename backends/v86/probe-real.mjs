import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createV86ProcessBackendV1 } from '../../adapters/node/src/capability-process-v86-backend.mjs'
import { createV86FuseBrokerProbeV1 } from './probe-fuse-broker.mjs'
import { createV86FuseMemoryProbeV1 } from './probe-fuse-memory.mjs'
import { createV86ProbeLaunchV1, loadV86ProbeArtifactsV1 } from './probe-real-launch.mjs'
import { createV86ProbeTraceV1 } from './probe-trace.mjs'

const usage = () => {
  throw new TypeError(
    'Usage: node probe-real.mjs <libv86.mjs> <v86.wasm> <seabios.bin> <kernel> <supervisor-initrd>'
  )
}

const main = async () => {
  const paths = process.argv.slice(2)
  if (paths.length !== 5) usage()

  const [modulePath, wasmPath, biosPath, kernelPath, initrdPath] = paths
  const { artifact, V86: ImportedV86, values } = await loadV86ProbeArtifactsV1({
    biosPath,
    initrdPath,
    kernelPath,
    modulePath,
    wasmPath
  })

  const trace = createV86ProbeTraceV1(ImportedV86)

  let supervisorKernelCapabilities = []
  const fuseRoot = process.env.HOLO_V86_BROKER_FS === '1'
    ? await mkdtemp(path.join(os.tmpdir(), 'holonomy-v86-fuse-broker-'))
    : undefined
  const fuse = fuseRoot == null
    ? createV86FuseMemoryProbeV1()
    : await createV86FuseBrokerProbeV1(fuseRoot)
  const executionRequests = []
  const backend = createV86ProcessBackendV1({
    V86: trace.V86,
    handleExecutionRequest(input) {
      executionRequests.push(input)
    },
    loadArtifact: input => values.get(input.artifactId),
    handleFilesystemRequest: fuse.handleFilesystemRequest,
    onKernelCapabilities: value => {
      supervisorKernelCapabilities = value
    },
    readyTimeoutMs: 60_000
  })
  const requiredKernelCapabilities = process.env.HOLO_V86_REQUIRED_KERNEL_CAPABILITIES == null
    ? ['process', 'fuse']
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

  const launch = createV86ProbeLaunchV1({
    backend,
    configuration,
    policy: fuse.policy ?? { access: 'sandboxed' }
  })

  try {
    if (process.env.HOLO_V86_HANDSHAKE_ONLY === '1') {
      const missing = launch('v86-real-handshake', '/usr/bin/holo-missing-workload', [])
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
      '/usr/bin/holo-v86-selftest',
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

    const signalled = launch('v86-real-signal', '/usr/bin/holo-v86-selftest', ['sleep'])
    await once(signalled.child, 'spawn')
    signalled.killTree('SIGTERM')
    const [signalCode, signalName] = await once(signalled.child, 'close')
    assert.equal(signalCode, null)
    assert.equal(signalName, 'SIGTERM')

    const fuseProcess = launch('v86-real-fuse', '/usr/bin/holo-v86-selftest', ['fuse'])
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
    assert.equal(backend.descriptor.features.filesystemBridge, true)

    const execveatProcess = launch('v86-real-execveat', '/usr/bin/holo-v86-selftest', ['execveat'])
    const execveatOutput = []
    execveatProcess.child.stdout.on('data', value => execveatOutput.push(value))
    const [execveatCode, execveatSignal] = await once(execveatProcess.child, 'close')
    assert.equal(execveatCode, 0)
    assert.equal(execveatSignal, null)
    assert.equal(
      Buffer.concat(execveatOutput).toString(),
      'EXECVEAT_ABSOLUTE_ALLOWED\nEXECVEAT_RELATIVE_DENIED\nEXECVEAT_DIRFD_DENIED\n' +
        'EXECVEAT_EMPTY_PATH_DENIED\n'
    )

    const failedExecProcess = launch(
      'v86-real-exec-failure',
      '/usr/bin/holo-v86-selftest',
      ['exec-failure']
    )
    const failedExecOutput = []
    failedExecProcess.child.stdout.on('data', value => failedExecOutput.push(value))
    const [failedExecCode, failedExecSignal] = await once(failedExecProcess.child, 'close')
    assert.equal(failedExecCode, 0)
    assert.equal(failedExecSignal, null)
    assert.equal(
      Buffer.concat(failedExecOutput).toString(),
      'EXEC_FAILURE_RETURNED\nEXEC_FAILURE_IDENTITY_RECOVERED\n'
    )
    const failedRequestIndex = executionRequests.findIndex(
      value => value.path === '/usr/bin/holo-v86-invalid-executable'
    )
    const failedRequest = executionRequests[failedRequestIndex]
    const recoveryRequest = executionRequests.slice(failedRequestIndex + 1).find(value =>
      value.path === '/usr/bin/holo-v86-selftest' && value.linuxPid === failedRequest?.linuxPid &&
      value.argv[1] === 'descendant-child'
    )
    assert.equal(failedRequest?.callerExecutableId, 'v86-real-exec-failure')
    assert.equal(recoveryRequest?.callerExecutableId, 'v86-real-exec-failure')

    assert.ok(requiredKernelCapabilities.every(value => supervisorKernelCapabilities.includes(value)))
    process.stdout.write(`${
      JSON.stringify({
        backendId: backend.descriptor.backendId,
        code,
        execFailureIdentity: true,
        execveat: true,
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
    process.stderr.write(`${trace.serial0Tail()}\n`)
    throw error
  } finally {
    await backend.closeGeneration(1)
    fuse.close?.()
    if (fuseRoot != null) await rm(fuseRoot, { force: true, recursive: true })
  }
}

void main()
