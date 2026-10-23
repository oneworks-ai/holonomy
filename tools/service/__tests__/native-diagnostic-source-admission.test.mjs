import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

// eslint-disable-next-line antfu/no-import-dist -- Service admission compares against the built Policy contract.
import { compileSandboxPolicyV2 } from '../../../dist/capability-runtime/index.js'
import { createServiceCapabilityRuntimeManagerV1 } from '../capability-runtime-manager.mjs'
import { materializeNativeLaunch, validateNativeLaunchGraph } from '../native-launch-materialization.mjs'
import { compileSandboxPolicy } from '../sandbox-policy.mjs'
import { runtimeLaunch } from './sandbox-fixture.mjs'

const installation = () => ({
  capabilityName: 'host.diagnostics.source.read',
  maxReadBytes: 1024 * 1024,
  maxReads: 1024
})

const diagnostics = sourceReader => ({
  maxObserverCallbackMs: 1,
  maxQueuedEvents: 0,
  maxSourceReadBytes: sourceReader === 'boundedSource' ? 8192 : 0,
  observerEvents: [],
  retentionMs: 0,
  sourceReader
})

const policy = sourceReader => ({ diagnostics: diagnostics(sourceReader), schemaVersion: 2 })

const request = sourceReader => ({
  context: {
    guest: { application: { id: 'example.guest', name: 'Example Guest' } },
    host: { tenantId: 'private-tenant' },
    inspector: { title: 'Example Guest' },
    schemaVersion: 1
  },
  initialMiddlewareId: 'service.continue.v1',
  sandboxPolicy: policy(sourceReader),
  schemaVersion: 1
})

const nativeExpected = () => {
  const entryUrl = 'app://workspace/main.mjs'
  return {
    entryUrl,
    fixture: undefined,
    inspectorMode: 'off',
    launch: {
      argv: [entryUrl],
      entryUrl,
      moduleRootUrl: 'app://workspace/',
      modules: [{ source: 'export {}', url: entryUrl }],
      schemaVersion: 2,
      target: 'native'
    },
    sandboxPolicy: compileSandboxPolicy().policy,
    target: 'native'
  }
}

const nodeExpected = () => ({
  entryUrl: 'app+local://workspace/main.mjs',
  fixture: undefined,
  inspectorMode: 'off',
  launch: runtimeLaunch('node', { source: 'export {}' }),
  sandboxPolicy: compileSandboxPolicy().policy,
  target: 'node'
})

const nativeProcess = (admitted, expected, id) => ({
  ...expected,
  capabilityRuntime: admitted,
  generation: 1,
  id
})

describe('native managed diagnostic source reader admission', () => {
  it('requires an exact, finite owner-private installation and freezes its values', async () => {
    const invalid = [
      null,
      [],
      {},
      { ...installation(), extra: true },
      { ...installation(), capabilityName: 'host.network.request-body.read' },
      { ...installation(), maxReadBytes: 0 },
      { ...installation(), maxReadBytes: 1024 * 1024 + 1 },
      { ...installation(), maxReadBytes: 1.5 },
      { ...installation(), maxReadBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...installation(), maxReads: 0 },
      { ...installation(), maxReads: 1025 },
      { ...installation(), maxReads: 1.5 }
    ]
    for (const selected of invalid) {
      assert.throws(
        () => createServiceCapabilityRuntimeManagerV1({ nativeDiagnosticSourceReader: selected }),
        TypeError
      )
    }
    let getterCalled = false
    const accessor = { ...installation() }
    Object.defineProperty(accessor, 'maxReads', {
      enumerable: true,
      get() {
        getterCalled = true
        return 1
      }
    })
    assert.throws(
      () => createServiceCapabilityRuntimeManagerV1({ nativeDiagnosticSourceReader: accessor }),
      TypeError
    )
    assert.equal(getterCalled, false)

    const selected = installation()
    const manager = createServiceCapabilityRuntimeManagerV1({ nativeDiagnosticSourceReader: selected })
    selected.maxReadBytes = 0
    selected.maxReads = 0
    const expected = nativeExpected()
    const admitted = manager.admit(request('boundedSource'), expected)
    const prepared = await manager.prepare(nativeProcess(admitted, expected, 'reader_frozen'))
    assert.deepEqual(prepared.diagnosticSourceReader, installation())
    assert(Object.isFrozen(prepared.diagnosticSourceReader))
  })

  it('keeps Node callback and Native installation independent and rejects public selection', () => {
    const native = nativeExpected()
    const node = nodeExpected()
    const nodeCaps = { capabilityName: 'host.diagnostics.source.read', maxReadBytes: 4096 }
    const nodeOnly = createServiceCapabilityRuntimeManagerV1({
      engineGate: () => ({ action: 'allow' }),
      sourceReaderHostCaps: nodeCaps
    })
    assert.throws(
      () => nodeOnly.admit(request('boundedSource'), native),
      error => error.code === 'sandbox.capability_unsupported'
    )
    const zeroBudget = request('boundedSource')
    zeroBudget.sandboxPolicy.diagnostics.maxSourceReadBytes = 0
    const selected = createServiceCapabilityRuntimeManagerV1({
      nativeDiagnosticSourceReader: installation()
    })
    assert.throws(
      () => selected.admit(zeroBudget, native),
      error => error.code === 'service.invalid_request'
    )
    assert.doesNotThrow(() => nodeOnly.admit(request('boundedSource'), node))

    const nativeOnly = createServiceCapabilityRuntimeManagerV1({
      nativeDiagnosticSourceReader: installation()
    })
    assert.throws(
      () => nativeOnly.admit(request('boundedSource'), node),
      error => error.code === 'sandbox.capability_unsupported'
    )
    assert.throws(
      () => nativeOnly.admit({ ...request('boundedSource'), diagnosticSourceReader: installation() }, native),
      error => error.code === 'service.invalid_request'
    )
  })

  it('selects only boundedSource for Native private staging without changing Policy or graph digests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-native-source-admission-'))
    const manager = createServiceCapabilityRuntimeManagerV1({
      nativeDiagnosticSourceReader: installation(),
      stateDirectory: directory
    })
    const expected = nativeExpected()
    try {
      for (const sourceReader of ['boundedSource', 'metadataOnly', 'none']) {
        const admitted = manager.admit(request(sourceReader), expected)
        assert.equal(admitted.policyDigest, compileSandboxPolicyV2(policy(sourceReader)).digest)
        assert.equal(Object.hasOwn(admitted, 'diagnosticSourceReader'), false)
        assert.equal(JSON.stringify(admitted).includes('host.diagnostics.source.read'), false)
        const process = nativeProcess(admitted, expected, `reader_${sourceReader}`)
        const prepared = await manager.prepare(process)
        assert.equal(prepared.policyDigest, admitted.policyDigest)
        assert.equal(
          Object.hasOwn(prepared, 'diagnosticSourceReader'),
          sourceReader === 'boundedSource'
        )
        const staged = await materializeNativeLaunch(process, directory, prepared)
        const hostConfig = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
        assert.equal(
          Object.hasOwn(hostConfig, 'diagnosticSourceReader'),
          sourceReader === 'boundedSource'
        )
        if (sourceReader === 'boundedSource') {
          assert.deepEqual(hostConfig.diagnosticSourceReader, installation())
        }
        assert.equal(staged.sourceGraphDigest, validateNativeLaunchGraph(expected.launch).digest)
      }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rechecks Native selection during prepare and rejects forged staging bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-native-source-recheck-'))
    const expected = nativeExpected()
    const unavailable = createServiceCapabilityRuntimeManagerV1({ stateDirectory: directory })
    const available = createServiceCapabilityRuntimeManagerV1({
      nativeDiagnosticSourceReader: installation(),
      stateDirectory: directory
    })
    try {
      const metadata = unavailable.admit(request('metadataOnly'), expected)
      const forged = {
        ...metadata,
        sandboxPolicy: {
          ...metadata.sandboxPolicy,
          diagnostics: { ...metadata.sandboxPolicy.diagnostics, ...diagnostics('boundedSource') }
        }
      }
      await assert.rejects(
        unavailable.prepare(nativeProcess(forged, expected, 'reader_forged_unavailable')),
        error => error.code === 'sandbox.capability_unsupported' || error.code === 'service.precondition_failed'
      )
      await assert.rejects(
        available.prepare(nativeProcess(forged, expected, 'reader_forged_digest')),
        error => error.code === 'service.precondition_failed'
      )
      await assert.rejects(
        materializeNativeLaunch(
          nativeProcess(metadata, expected, 'reader_forged_stage'),
          directory,
          {
            diagnosticSourceReader: installation(),
            policy: metadata.sandboxPolicy,
            policyDigest: metadata.policyDigest
          }
        ),
        error => error.code === 'service.precondition_failed'
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
