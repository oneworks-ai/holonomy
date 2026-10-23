import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { it as test } from 'vitest'

import { NativeV86ProcessNetworkBrokerV1 } from '../bootstrap/process-v86-network-broker.mjs'

test('write queue enforces the four MiB aggregate reservation through close', async () => {
  const releases = []
  const closed = []
  const delivered = []
  let opened = 0
  const broker = new NativeV86ProcessNetworkBrokerV1({
    async authorize() {
      return { resolutionToken: 'dns', receipt: { authorized: true }, address: '127.0.0.1' }
    },
    async task(kind) {
      if (kind === 'openTcp') return { socketToken: `tcp-${++opened}` }
      if (kind === 'readTcp') return new Promise(() => {})
      if (kind === 'writeTcp') return new Promise(resolve => releases.push(resolve))
      throw new Error(`Unexpected ${kind}`)
    },
    close(token) {
      closed.push(token)
    },
    closeEnvironment() {},
    closeGeneration() {}
  })
  const guest = {
    consumeNetworkAdmission: () => ({ linuxPid: 29, processId: 23 }),
    environmentId: 'vm-1',
    generation: 1,
    policy: { network: { access: 'restricted', endpoints: [], maxSockets: 32 } },
    scope: 'processTree',
    signal: new AbortController().signal
  }
  const chunk = Buffer.alloc(16 * 1024).toString('base64')
  for (let streamId = 1; streamId <= 16; streamId += 1) {
    await broker.handle(
      { kind: 'tcpOpen', streamId, address: '127.0.0.1', port: 9000 },
      guest,
      value => delivered.push(value)
    )
    for (let index = 0; index < 16; index += 1) {
      broker.handle({ kind: 'tcpData', streamId, base64: chunk }, guest, value => delivered.push(value))
    }
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(releases.length, 16)
  assert.equal(broker.pendingWriteBytes, 4 * 1024 * 1024)
  await broker.handle(
    { kind: 'tcpOpen', streamId: 17, address: '127.0.0.1', port: 9000 },
    guest,
    value => delivered.push(value)
  )
  broker.handle({ kind: 'tcpData', streamId: 17, base64: chunk }, guest, value => delivered.push(value))
  assert.equal(delivered.at(-1).action, 'tcpClose')
  assert.equal(broker.pendingWriteBytes, 4 * 1024 * 1024)
  broker.closeGeneration()
  assert.equal(broker.pendingWriteBytes, 4 * 1024 * 1024)
  for (const release of releases) release({ written: 16 * 1024 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(broker.pendingWriteBytes, 0)
})
