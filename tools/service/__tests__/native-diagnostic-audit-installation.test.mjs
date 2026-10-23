import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createHolonomyServiceLifecycleManager } from '../lifecycle-manager.mjs'
import {
  normalizeNativeDiagnosticAuditInstallation,
  selectNativeDiagnosticAuditForPolicy
} from '../native-diagnostic-audit-installation.mjs'
import {
  readServiceNativeRuntimeInstallation,
  readServiceNativeRuntimeInstallationDetails
} from '../native-runtime-installation.mjs'

const audit = Object.freeze({ maxBytes: 1_048_576 })
const reader = Object.freeze({
  capabilityName: 'host.diagnostics.source.read',
  maxReadBytes: 65_536,
  maxReads: 8
})
const device = Object.freeze({ implementation: 'builtin.darwin-device-v1' })

const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'holo-audit-install-')))
  const executablePath = join(home, 'holo')
  await writeFile(executablePath, '', { mode: 0o700 })
  await chmod(executablePath, 0o700)
  return {
    home,
    executablePath,
    write: async extra =>
      await writeFile(
        join(home, 'native-runtime.json'),
        JSON.stringify({ executablePath, schemaVersion: 1, ...extra }),
        { mode: 0o600 }
      )
  }
}

describe('native diagnostic audit owner selection', () => {
  it('accepts exact bounds, freezes a data copy and rejects accessors and Proxies without invoking them', () => {
    assert.equal(normalizeNativeDiagnosticAuditInstallation(undefined), undefined)
    for (const maxBytes of [1_024, 16_777_216]) {
      const input = { maxBytes }
      const selected = normalizeNativeDiagnosticAuditInstallation(input)
      assert.deepEqual(selected, input)
      assert.notEqual(selected, input)
      assert(Object.isFrozen(selected))
      input.maxBytes = 0
      assert.equal(selected.maxBytes, maxBytes)
    }
    let calls = 0
    const accessor = Object.defineProperty({}, 'maxBytes', {
      enumerable: true,
      get() {
        calls += 1
        return 1024
      }
    })
    const proxy = new Proxy({ maxBytes: 1024 }, {
      get() {
        calls += 1
        return 1024
      },
      getOwnPropertyDescriptor() {
        calls += 1
        return { configurable: true, enumerable: true, value: 1024 }
      },
      getPrototypeOf() {
        calls += 1
        return Object.prototype
      },
      ownKeys() {
        calls += 1
        return ['maxBytes']
      }
    })
    for (
      const input of [
        null,
        [],
        {},
        { maxBytes: 1023 },
        { maxBytes: 16_777_217 },
        { maxBytes: 1024.5 },
        { maxBytes: '1024' },
        { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
        { maxBytes: 1024, path: '/tmp/audit.jsonl' },
        accessor,
        proxy,
        Object.defineProperty({}, 'maxBytes', { value: 1024 }),
        new (class Audit {
          maxBytes = 1024
        })()
      ]
    ) assert.throws(() => normalizeNativeDiagnosticAuditInstallation(input), TypeError)
    assert.equal(calls, 0)
  })

  it('selects only for bounded source with a separate installed reader', () => {
    const policy = sourceReader => ({ diagnostics: { sourceReader } })
    assert.deepEqual(selectNativeDiagnosticAuditForPolicy(policy('boundedSource'), audit, reader), audit)
    for (const sourceReader of ['metadataOnly', 'none']) {
      assert.equal(selectNativeDiagnosticAuditForPolicy(policy(sourceReader), audit, reader), undefined)
    }
    assert.equal(selectNativeDiagnosticAuditForPolicy(policy('boundedSource'), audit, undefined), undefined)
    assert.equal(selectNativeDiagnosticAuditForPolicy(policy('boundedSource'), undefined, reader), undefined)
  })

  it('reads every permitted optional manifest combination and preserves the path-only API', async () => {
    const f = await fixture()
    try {
      const devices = process.platform === 'darwin' && process.arch === 'arm64' ? [false, true] : [false]
      for (const hasDevice of devices) {
        for (const hasReader of [false, true]) {
          for (const hasAudit of [false, true]) {
            const optional = {
              ...(hasDevice ? { deviceProvider: device } : {}),
              ...(hasReader ? { diagnosticSourceReader: reader } : {}),
              ...(hasAudit ? { diagnosticAudit: audit } : {})
            }
            await f.write(optional)
            const details = await readServiceNativeRuntimeInstallationDetails(f.home)
            assert.deepEqual(details, { executablePath: f.executablePath, ...optional })
            assert(Object.isFrozen(details))
            if (hasAudit) {
              assert(Object.isFrozen(details.diagnosticAudit))
              assert.notEqual(details.diagnosticAudit, audit)
            }
            assert.equal(await readServiceNativeRuntimeInstallation(f.home), f.executablePath)
          }
        }
      }
    } finally {
      await rm(f.home, { recursive: true, force: true })
    }
  })

  it('rejects null, unknown manifest and audit fields, paths and invalid limits', async () => {
    const f = await fixture()
    try {
      for (
        const value of [
          null,
          {},
          { maxBytes: null },
          { maxBytes: 1023 },
          { maxBytes: 16_777_217 },
          { maxBytes: 1024.5 },
          { maxBytes: '1024' },
          { maxBytes: 1024, path: './audit.jsonl' }
        ]
      ) {
        await f.write({ diagnosticAudit: value })
        await assert.rejects(readServiceNativeRuntimeInstallationDetails(f.home), {
          code: 'service.state_corrupt'
        })
      }
      await f.write({ diagnosticAudit: audit, publicAuditPath: './audit.jsonl' })
      await assert.rejects(readServiceNativeRuntimeInstallationDetails(f.home), {
        code: 'service.state_corrupt'
      })
    } finally {
      await rm(f.home, { recursive: true, force: true })
    }
  })

  it('reselects the owner installation on each Service startup', async () => {
    const f = await fixture()
    const selected = []
    const manager = createHolonomyServiceLifecycleManager({
      client: { status: async () => ({ running: false }) },
      createService: options => {
        selected.push(options.nativeDiagnosticAudit)
        return {
          close: async () => undefined,
          core: {
            listEmulators: async () => [],
            snapshot: () => ({ resources: { inspectors: {}, processes: {} } })
          },
          start: async () => 'http://127.0.0.1:43210'
        }
      },
      home: f.home
    })
    try {
      await f.write({ diagnosticAudit: { maxBytes: 1_024 } })
      await manager.ensure()
      await manager.stop()
      await f.write({ diagnosticAudit: { maxBytes: 2_048 } })
      await manager.ensure()
      assert.deepEqual(selected, [{ maxBytes: 1_024 }, { maxBytes: 2_048 }])
      assert(selected.every(value => Object.isFrozen(value)))
      assert.notEqual(selected[0], selected[1])
    } finally {
      await manager.stop({ drain: true }).catch(() => undefined)
      await rm(f.home, { recursive: true, force: true })
    }
  })
})
