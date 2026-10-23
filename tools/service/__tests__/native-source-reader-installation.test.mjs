import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, vi } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import {
  readServiceNativeRuntimeInstallation,
  readServiceNativeRuntimeInstallationDetails
} from '../native-runtime-installation.mjs'
import { createHolonomyService } from '../server.mjs'

const createdRuntimeManager = vi.hoisted(() => ({ options: undefined }))
vi.mock('../capability-runtime-manager.mjs', async importOriginal => {
  const original = await importOriginal()
  return {
    ...original,
    createServiceCapabilityRuntimeManagerV1: options => {
      createdRuntimeManager.options = options
      return original.createServiceCapabilityRuntimeManagerV1(options)
    }
  }
})

const sourceReader = Object.freeze({
  capabilityName: 'host.diagnostics.source.read',
  maxReadBytes: 65_536,
  maxReads: 8
})
const deviceProvider = Object.freeze({ implementation: 'builtin.darwin-device-v1' })

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'holo-native-source-install-')))
  const executablePath = join(home, 'holo')
  const manifest = join(home, 'native-runtime.json')
  await writeFile(executablePath, '', { mode: 0o700 })
  await chmod(executablePath, 0o700)
  return {
    executablePath,
    home,
    manifest,
    write: async value =>
      await writeFile(
        manifest,
        JSON.stringify({ executablePath, schemaVersion: 1, ...value }),
        { mode: 0o600 }
      )
  }
}

describe('owner-only Native diagnostic source reader installation', () => {
  it('preserves the path-only API and copies a strictly selected private reader', async () => {
    const entry = await fixture()
    try {
      await entry.write({})
      assert.deepEqual(await readServiceNativeRuntimeInstallationDetails(entry.home), {
        executablePath: entry.executablePath
      })
      await entry.write({ diagnosticSourceReader: sourceReader })
      const details = await readServiceNativeRuntimeInstallationDetails(entry.home)
      assert.deepEqual(details, {
        diagnosticSourceReader: sourceReader,
        executablePath: entry.executablePath
      })
      assert.equal(await readServiceNativeRuntimeInstallation(entry.home), entry.executablePath)
      assert.equal(Object.isFrozen(details), true)
      assert.equal(Object.isFrozen(details.diagnosticSourceReader), true)
      assert.notEqual(details.diagnosticSourceReader, sourceReader)
    } finally {
      await rm(entry.home, { force: true, recursive: true })
    }
  })

  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'combines the optional Device selector with the source reader',
    async () => {
      const entry = await fixture()
      try {
        await entry.write({ deviceProvider, diagnosticSourceReader: sourceReader })
        const details = await readServiceNativeRuntimeInstallationDetails(entry.home)
        assert.deepEqual(details, {
          deviceProvider,
          diagnosticSourceReader: sourceReader,
          executablePath: entry.executablePath
        })
        assert.equal(Object.isFrozen(details.deviceProvider), true)
      } finally {
        await rm(entry.home, { force: true, recursive: true })
      }
    }
  )

  it('rejects unknown keys, nulls, incorrect capability, unsafe numbers and bounds', async () => {
    const entry = await fixture()
    try {
      for (
        const diagnosticSourceReader of [
          null,
          {},
          { ...sourceReader, capabilityName: 'host.network.request-body.read' },
          { ...sourceReader, maxReadBytes: 0 },
          { ...sourceReader, maxReadBytes: 1_048_577 },
          { ...sourceReader, maxReadBytes: 1.5 },
          { ...sourceReader, maxReadBytes: Number.MAX_SAFE_INTEGER + 1 },
          { ...sourceReader, maxReads: 0 },
          { ...sourceReader, maxReads: 1_025 },
          { ...sourceReader, maxReads: '8' },
          { ...sourceReader, source: 'guest' }
        ]
      ) {
        await entry.write({ diagnosticSourceReader })
        await assert.rejects(readServiceNativeRuntimeInstallationDetails(entry.home), {
          code: 'service.state_corrupt'
        })
      }
      await entry.write({ diagnosticSourceReader: sourceReader, publicSelection: true })
      await assert.rejects(readServiceNativeRuntimeInstallationDetails(entry.home), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(entry.home, { force: true, recursive: true })
    }
  })

  it('rejects readable-by-group installation and symbolic-link ingress', async () => {
    const entry = await fixture()
    try {
      await entry.write({ diagnosticSourceReader: sourceReader })
      await chmod(entry.manifest, 0o640)
      await assert.rejects(readServiceNativeRuntimeInstallationDetails(entry.home), {
        code: 'service.state_corrupt'
      })
      await rm(entry.manifest)
      const backing = join(entry.home, 'backing.json')
      await writeFile(
        backing,
        JSON.stringify({
          diagnosticSourceReader: sourceReader,
          executablePath: entry.executablePath,
          schemaVersion: 1
        }),
        { mode: 0o600 }
      )
      await symlink(backing, entry.manifest)
      await assert.rejects(readServiceNativeRuntimeInstallationDetails(entry.home), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(entry.home, { force: true, recursive: true })
    }
  })

  it('passes the installed reader only in the private Service option', async () => {
    const entry = await fixture()
    const nodeCaps = Object.freeze({ capabilityName: 'host.diagnostics.source.read', maxReadBytes: 7 })
    let received
    const service = {
      close: async () => undefined,
      core: { snapshot: () => ({ resources: { inspectors: {}, processes: {} } }) },
      start: async () => 'http://127.0.0.1:43210'
    }
    const manager = createHolonomyServiceLifecycleManager({
      client: { status: async () => ({ running: false }) },
      createService: options => {
        received = options
        return service
      },
      home: entry.home,
      service: { capabilityEngineSourceReaderHostCaps: nodeCaps }
    })
    try {
      await entry.write({ diagnosticSourceReader: sourceReader })
      await manager.ensure()
      assert.deepEqual(received.nativeDiagnosticSourceReader, sourceReader)
      assert.equal(received.capabilityEngineSourceReaderHostCaps, nodeCaps)
      assert.equal(Object.hasOwn(received, 'diagnosticSourceReader'), false)
      assert.equal(Object.hasOwn(received, 'sourceReaderHostCaps'), false)
    } finally {
      await manager.stop({ drain: true }).catch(() => undefined)
      await rm(entry.home, { force: true, recursive: true })
    }
  })

  it('passes separate Native and Node caps through Service/Core without publishing the installation', async () => {
    const entry = await fixture()
    const nodeCaps = Object.freeze({ capabilityName: 'host.diagnostics.source.read', maxReadBytes: 7 })
    const token = 'native-source-reader-private-token-1234'
    const service = createHolonomyService({
      capabilityEngineSourceReaderHostCaps: nodeCaps,
      nativeDiagnosticSourceReader: sourceReader,
      nativeExecutablePath: entry.executablePath,
      port: 0,
      stateDirectory: entry.home,
      token
    })
    try {
      assert.deepEqual(createdRuntimeManager.options.nativeDiagnosticSourceReader, sourceReader)
      assert.equal(createdRuntimeManager.options.sourceReaderHostCaps, nodeCaps)
      const baseUrl = await service.start()
      const response = await fetch(`${baseUrl}/v1/service`, {
        headers: { authorization: `Bearer ${token}` }
      })
      assert.equal(response.status, 200)
      const body = await response.text()
      assert.equal(body.includes('diagnosticSourceReader'), false)
      assert.equal(body.includes('nativeDiagnosticSourceReader'), false)
      assert.equal(body.includes(entry.executablePath), false)
    } finally {
      await service.close()
      await rm(entry.home, { force: true, recursive: true })
    }
  })
})
