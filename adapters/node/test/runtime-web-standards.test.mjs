import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- The adapter suite uses Node's public test runner.
import { test } from 'node:test'

import { RuntimeTextDecoder, RuntimeURL } from '../src/runtime-web-standards.mjs'

test('planner URL separates empty delimiters from public search/hash values', () => {
  for (const suffix of ['', '?', '#', '?#', '?one', '?one#', '#value']) {
    const input = `app://workspace/file.mjs${suffix}`
    const actual = new RuntimeURL(input)
    const expected = new URL(input)
    assert.equal(actual.href, expected.href, input)
    assert.equal(actual.search, expected.search, input)
    assert.equal(actual.hash, expected.hash, input)
    assert.equal(actual.toString(), expected.toString(), input)
    const relative = new RuntimeURL(`./file.mjs${suffix}`, 'app://workspace/parent.mjs')
    assert.equal(relative.href, expected.href, input)
    assert.equal(relative.search, expected.search, input)
    assert.equal(relative.hash, expected.hash, input)
  }
})

test('planner URL setters retain empty delimiters without inventing nonempty values', () => {
  const actual = new RuntimeURL('app://workspace/file.mjs')
  const expected = new URL(actual.href)
  for (
    const [name, value] of [
      ['search', '?'],
      ['hash', '#'],
      ['search', '?one'],
      ['hash', '#two'],
      ['search', 'three'],
      ['hash', 'four'],
      ['search', ''],
      ['hash', '']
    ]
  ) {
    actual[name] = value
    expected[name] = value
    assert.equal(actual.href, expected.href)
    assert.equal(actual[name], expected[name])
  }
})

test('planner UTF-8 decoder consumes one leading BOM by default and preserves it when requested', () => {
  const bom = [0xEF, 0xBB, 0xBF]
  const one = Uint8Array.from([...bom, 0x61])
  const two = Uint8Array.from([...bom, ...bom, 0x61])
  assert.equal(new RuntimeTextDecoder().decode(one), 'a')
  assert.equal(new RuntimeTextDecoder('utf-8', { ignoreBOM: true }).decode(one), '\uFEFFa')
  assert.equal(new RuntimeTextDecoder().decode(two), '\uFEFFa')
  assert.equal(new RuntimeTextDecoder().decode(Uint8Array.from([0x61, ...bom])), 'a\uFEFF')
  const decoder = new RuntimeTextDecoder()
  assert.equal(decoder.decode(one), 'a')
  assert.equal(decoder.decode(one), 'a')
})

test('planner UTF-8 decoder applies BOM handling to nonfatal invalid prefixes without changing fatal errors', () => {
  const invalid = Uint8Array.from([0xEF, 0xBB, 0xBF, 0xFF])
  assert.equal(new RuntimeTextDecoder().decode(invalid), '\uFFFD')
  assert.equal(new RuntimeTextDecoder('utf-8', { ignoreBOM: true }).decode(invalid), '\uFEFF\uFFFD')
  assert.throws(() => new RuntimeTextDecoder('utf-8', { fatal: true }).decode(invalid), TypeError)
})
