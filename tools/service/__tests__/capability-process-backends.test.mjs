import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { readServiceProcessBackendsV1 } from '../capability-process-backends.mjs'

describe('service Process Backend manifest', () => {
  it('installs the built-in v86 implementation only from an owner-private Host manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-process-backends-'))
    const path = join(directory, 'process-backends.json')
    try {
      await writeFile(
        path,
        JSON.stringify({
          backends: {
            'experimental.v86-v1': {
              artifactRoot: directory,
              implementation: 'builtin.v86-v1'
            }
          },
          schemaVersion: 1
        }),
        { mode: 0o600 }
      )
      const state = await readServiceProcessBackendsV1(path)
      assert.deepEqual(state.installations['experimental.v86-v1'], {
        artifactRoot: directory,
        backendId: 'experimental.v86-v1',
        implementation: 'builtin.v86-v1'
      })
      assert.equal(
        state.registry.get('experimental.v86-v1').descriptor.family,
        'virtual-machine'
      )

      await chmod(path, 0o644)
      await assert.rejects(
        readServiceProcessBackendsV1(path),
        error => error.code === 'service.state_corrupt'
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('treats an absent Host manifest as only the platform built-ins', async () => {
    const state = await readServiceProcessBackendsV1('/definitely/missing/holonomy/process-backends.json')
    assert.deepEqual(state.installations, {})
    assert.equal(state.registry.get('experimental.v86-v1'), undefined)
  })

  it('rejects unknown implementations instead of publishing a candidate descriptor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-process-backends-invalid-'))
    const path = join(directory, 'process-backends.json')
    try {
      await writeFile(
        path,
        JSON.stringify({
          backends: {
            'experimental.agentos-v1': {
              artifactRoot: directory,
              implementation: 'builtin.agentos-v1'
            }
          },
          schemaVersion: 1
        }),
        { mode: 0o600 }
      )
      await assert.rejects(
        readServiceProcessBackendsV1(path),
        error => error.code === 'service.state_corrupt'
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
