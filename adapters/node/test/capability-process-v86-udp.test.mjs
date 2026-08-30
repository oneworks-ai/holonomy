import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { decodeV86UdpDatagramV1, encodeV86UdpResponseV1 } from '../src/capability-process-v86-udp.mjs'

const checksum = bytes => {
  let sum = 0
  for (let index = 0; index < bytes.length; index += 2) {
    sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0)
    while (sum > 0xFFFF) sum = (sum & 0xFFFF) + (sum >>> 16)
  }
  return (~sum) & 0xFFFF
}

const request = () => {
  const payload = Buffer.from('guest-udp')
  const output = new Uint8Array(42 + payload.length)
  const view = new DataView(output.buffer)
  output.set([0x52, 0x54, 0, 1, 2, 3], 0)
  output.set([0x00, 0x22, 0x15, 0x44, 0x55, 0x66], 6)
  view.setUint16(12, 0x0800)
  output[14] = 0x45
  view.setUint16(16, 28 + payload.length)
  view.setUint16(20, 0x4000)
  output[22] = 64
  output[23] = 17
  output.set([192, 168, 86, 100], 26)
  output.set([127, 0, 0, 1], 30)
  view.setUint16(24, checksum(output.subarray(14, 34)))
  view.setUint16(34, 49_152)
  view.setUint16(36, 8124)
  view.setUint16(38, 8 + payload.length)
  output.set(payload, 42)
  return output
}

test('parses a strict v86 IPv4 UDP frame and encodes its Guest response', () => {
  const decoded = decodeV86UdpDatagramV1(request())
  assert.ok(decoded)
  assert.equal(decoded.internal, false)
  assert.deepEqual(decoded.destinationAddress, [127, 0, 0, 1])
  assert.equal(decoded.destinationPort, 8124)
  assert.equal(Buffer.from(decoded.payload).toString(), 'guest-udp')

  const response = encodeV86UdpResponseV1(decoded, Buffer.from('host-udp'))
  const reverse = decodeV86UdpDatagramV1(response)
  assert.ok(reverse)
  assert.deepEqual(reverse.destinationAddress, [192, 168, 86, 100])
  assert.equal(reverse.destinationPort, 49_152)
  assert.equal(Buffer.from(reverse.payload).toString(), 'host-udp')
  assert.notEqual(new DataView(response.buffer).getUint16(24), 0)
  assert.equal(checksum(response.subarray(14, 34)), 0)
})

test('leaves router DNS to v86 and rejects fragmented or oversized datagrams', () => {
  const dns = request()
  dns.set([192, 168, 86, 1], 30)
  new DataView(dns.buffer).setUint16(36, 53)
  assert.equal(decodeV86UdpDatagramV1(dns)?.internal, true)

  const fragmented = request()
  new DataView(fragmented.buffer).setUint16(20, 0x2000)
  assert.equal(decodeV86UdpDatagramV1(fragmented), undefined)
  assert.throws(() => encodeV86UdpResponseV1(decodeV86UdpDatagramV1(request()), new Uint8Array(1473)), TypeError)
})
