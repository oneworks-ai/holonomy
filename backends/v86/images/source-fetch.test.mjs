/* eslint-disable test/no-import-node-test -- Image build tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { sha256 } from './image-contract.mjs'
import { fetchPinnedImageBytesV1, parseImageSourceMirrorV1 } from './source-fetch.mjs'

const url = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86/example.apk'
const bytes = new TextEncoder().encode('pinned package bytes')
const expected = sha256(bytes)
const mirror = parseImageSourceMirrorV1('https://mirror.example')
const location = 'https://mirror.example/alpine/v3.24/main/x86/example.apk'

test('image source mirror preserves the locked path and exact digest', async () => {
  const calls = []
  const result = await fetchPinnedImageBytesV1({
    expected,
    url,
    mirror,
    transport: async (input, options) => {
      calls.push([input, options])
      return { ok: true, url: input, arrayBuffer: async () => bytes }
    }
  })
  assert.deepEqual(calls, [[location, { redirect: 'manual' }]])
  assert.deepEqual(result, bytes)
})

test('image source mirror rejects redirects and changed bytes', async () => {
  await assert.rejects(
    fetchPinnedImageBytesV1({
      expected,
      url,
      mirror,
      transport: async () => ({ ok: false, url: location })
    }),
    /download failed/u
  )
  await assert.rejects(
    fetchPinnedImageBytesV1({
      expected,
      url,
      mirror,
      transport: async () => ({ ok: true, url: 'https://other.example/example.apk' })
    }),
    /download failed/u
  )
  await assert.rejects(
    fetchPinnedImageBytesV1({
      expected,
      url,
      mirror,
      transport: async () => ({ ok: true, url: location, arrayBuffer: async () => new Uint8Array([1]) })
    }),
    /digest mismatch/u
  )
})

test('image source mirror accepts HTTPS origins only', async () => {
  for (const value of ['http://mirror.example', 'https://user@mirror.example', 'https://mirror.example/path']) {
    assert.throws(() => parseImageSourceMirrorV1(value), /HTTPS origin/u)
  }
  await assert.rejects(
    fetchPinnedImageBytesV1({
      expected,
      url: 'http://dl-cdn.alpinelinux.org/example.apk',
      mirror
    }),
    /HTTPS URL/u
  )
  await assert.rejects(
    fetchPinnedImageBytesV1({
      expected,
      url: 'https://dl-cdn.alpinelinux.org//other.example/example.apk',
      mirror
    }),
    /HTTPS URL/u
  )
})
