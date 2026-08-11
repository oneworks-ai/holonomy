import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { serviceError } from '../errors.mjs'
import { DurableMutationCoordinator } from '../mutation-coordinator.mjs'

describe('durable mutation coordinator', () => {
  it('replays successful mutations after reopen and rejects key drift', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-mutations-'))
    const file = join(directory, 'mutations.json')
    let calls = 0
    try {
      const first = new DurableMutationCoordinator({ file })
      assert.deepEqual(
        await first.execute('emulator.start:pixel', 'stable-key', { coldBoot: true }, async () => {
          calls += 1
          return { managed: true, ownerNonce: 'owner' }
        }),
        { managed: true, ownerNonce: 'owner' }
      )
      const reopened = new DurableMutationCoordinator({ file })
      assert.deepEqual(
        await reopened.execute(
          'emulator.start:pixel',
          'stable-key',
          { coldBoot: true },
          async () => {
            calls += 1
            return { managed: false }
          }
        ),
        { managed: true, ownerNonce: 'owner' }
      )
      assert.equal(calls, 1)
      await assert.rejects(
        reopened.execute('emulator.start:pixel', 'stable-key', { coldBoot: false }, async () => ({})),
        error => error.code === 'service.conflict'
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('never executes work or caches an empty history when the first load is corrupt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-mutations-corrupt-'))
    const file = join(directory, 'mutations.json')
    let calls = 0
    try {
      await writeFile(file, '{"version":1,"records":')
      const coordinator = new DurableMutationCoordinator({ file })
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          coordinator.execute('service.shutdown', 'stable-key', { drain: true }, async () => calls += 1),
          error => error.code === 'service.state_corrupt'
        )
      }
      assert.equal(calls, 0)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('retries a transient first-read failure without executing mutation work', async () => {
    let calls = 0
    let reads = 0
    const coordinator = new DurableMutationCoordinator({
      file: '/virtual/mutations.json',
      readJson: async () => {
        reads += 1
        throw serviceError('service.state_corrupt', 'temporarily unreadable')
      }
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        coordinator.execute('service.shutdown', 'stable-key', { drain: true }, async () => calls += 1),
        error => error.code === 'service.state_corrupt'
      )
    }
    assert.equal(reads, 2)
    assert.equal(calls, 0)
  })
})
