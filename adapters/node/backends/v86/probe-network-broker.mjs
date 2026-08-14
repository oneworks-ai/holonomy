import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { CapabilityRuntimeInvocationKernelV1, admitRuntimeCreationV1 } from 'holonomy/capability-runtime'
import { NodeProcessBackendRegistryV1 } from '../../src/capability-process-backend.mjs'
import { NodeProcessProviderV1 } from '../../src/capability-process-provider.mjs'
import { createV86ProcessBackendV1 } from '../../src/capability-process-v86-backend.mjs'
import { NodeV86ProcessNetworkBrokerV1 } from '../../src/capability-process-v86-network-broker.mjs'
import { capabilityRuntimeSession } from '../../test/capability-runtime-fixture.mjs'
import { createV86FuseMemoryProbeV1 } from './probe-fuse-memory.mjs'

const usage = () => {
  throw new TypeError(
    'Usage: node probe-network-broker.mjs <libv86.mjs> <v86.wasm> <seabios.bin> <kernel> <supervisor-initrd>'
  )
}

const main = async () => {
  const paths = process.argv.slice(2)
  if (paths.length !== 5) usage()
  const [modulePath, wasmPath, biosPath, kernelPath, initrdPath] = paths
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
  const { V86: ImportedV86 } = await import(pathToFileURL(modulePath).href)
  class ProbeV86 extends ImportedV86 {
    constructor(options) {
      super(options)
      if (process.env.HOLO_V86_TRACE === '1') {
        this.add_listener('serial0-output-byte', byte => process.stderr.write(String.fromCharCode(byte)))
        for (const event of ['emulator-ready', 'emulator-started', 'emulator-stopped', 'download-error']) {
          this.add_listener(event, () => process.stderr.write(`[v86:${event}]\n`))
        }
      }
    }
  }
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v86')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('HOLO_V86_NETWORK_OK')
  })
  server.listen({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address != null && typeof address === 'object')
  const network = new NodeV86ProcessNetworkBrokerV1()
  const filesystem = createV86FuseMemoryProbeV1()
  const backend = createV86ProcessBackendV1({
    V86: ProbeV86,
    handleFilesystemRequest: filesystem.handleFilesystemRequest,
    handleNetworkRequest: input => network.fetch(input),
    loadArtifact: input => values.get(input.artifactId),
    readyTimeoutMs: 60_000
  })
  const configuration = backend.normalizeConfiguration({
    artifacts: {
      bios: artifact('bios'),
      initrd: artifact('initrd'),
      kernel: artifact('kernel'),
      wasm: artifact('wasm')
    },
    memoryBytes: 128 * 1024 * 1024,
    requiredKernelCapabilities: ['process'],
    supervisor: { protocolVersion: 1 }
  })
  const profile = {
    backend: { backendId: backend.descriptor.backendId, configuration },
    environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
    executables: [{
      executable: { kind: 'guestPath', path: '/holo-selftest' },
      executableId: 'v86-real-network',
      fixedArgs: [],
      shell: false
    }],
    profile: 'process-profile-v1'
  }
  const raw = capabilityRuntimeSession({
    entryUrl: 'app+local://workspace/main.mjs',
    hostPath: process.cwd(),
    moduleRootUrl: 'app+local://workspace/',
    processProfile: profile,
    source: 'export {}'
  }).capabilityRuntime
  const policy = raw.runtimeCreation.configuration.sandboxPolicy.process
  policy.network = {
    access: 'restricted',
    endpoints: [{ hostname: '127.0.0.1', ports: [address.port], transport: 'tcp' }],
    maxSockets: 1
  }
  const processBinding = raw.runtimeCreation.hostBindings.providerBindings.find(
    item => item.module === 'host.process'
  )
  const events = []
  const middleware = {
    registrations: [{
      execution: 'async',
      layer: 'application',
      matcher: { operation: 'process.network.connect' },
      middleware: async (context, next) => {
        events.push({ operation: context.operation, resource: context.resource.requested, source: context.source })
        return await next()
      },
      registrationId: 'v86-network-probe'
    }],
    schemaVersion: 1
  }
  const registry = new NodeProcessBackendRegistryV1([backend])
  const provider = new NodeProcessProviderV1(profile, policy, 1, registry)
  const spec = {
    configuration: raw.runtimeCreation.configuration,
    hostBindings: { ...raw.runtimeCreation.hostBindings, providerBindings: [processBinding] }
  }
  const resolved = new Map([
    [spec.hostBindings.engineGate.bindingId, {}],
    [spec.hostBindings.initialMiddlewareSet.bindingId, middleware],
    [spec.hostBindings.moduleResolver.bindingId, {}],
    [processBinding.providerId, provider]
  ])
  const admitted = admitRuntimeCreationV1(spec, {
    expectedOwnerId: raw.ownerId,
    generation: 1,
    processId: raw.processId,
    resolveBinding: reference => resolved.get(reference.bindingId)
  })
  const kernel = new CapabilityRuntimeInvocationKernelV1({
    admitted,
    engine: 'node-v8-v86-network-probe',
    networkProvider: 'host.network',
    requestPrefix: 'v86-network',
    target: 'node'
  })
  network.bind(input => kernel.invokeFromSource(input))
  const launch = backend.prepareLaunch({
    configuration,
    environmentScope: 'processTree',
    executable: { kind: 'guestPath', path: '/holo-selftest' },
    executableId: 'v86-real-network',
    generation: 1,
    policy,
    runtimeArgs: ['network', String(address.port)]
  })
  const running = backend.spawn(
    launch,
    { cwd: '/', env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] },
    { processResourceId: 'v86-network-process' }
  )
  const stdout = []
  const stderr = []
  running.child.stdout.on('data', value => stdout.push(value))
  running.child.stderr.on('data', value => stderr.push(value))
  try {
    const [code, signal] = await once(running.child, 'close')
    const output = Buffer.concat(stdout).toString()
    assert.equal(code, 0, Buffer.concat(stderr).toString())
    assert.equal(signal, null)
    assert.match(output, /HTTP\/1\.1 200/u)
    assert.match(output, /HOLO_V86_NETWORK_OK/u)
    assert.equal(events.length, 1)
    assert.equal(events[0].source.executableId, 'v86-real-network')
    assert.ok(events[0].source.linuxPid > 1)
    assert.equal(events[0].resource.hostname, '127.0.0.1')
    assert.equal(events[0].resource.port, address.port)
    process.stdout.write(`${
      JSON.stringify({
        backendId: backend.descriptor.backendId,
        code,
        linuxPid: events[0].source.linuxPid,
        networkBridge: backend.descriptor.features.networkBridge,
        syntheticProcessId: events[0].source.syntheticProcessId,
        verified: true
      })
    }\n`)
  } finally {
    kernel.close()
    await provider.close()
    server.close()
  }
}

void main()
