import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { readChildEvent } from '../src/protocol.mjs'
import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'
import { sandboxSession } from './sandbox-fixture.mjs'

const base = () => ({
  entryUrl: 'custom+app://session/main.mjs',
  userModules: [{ source: 'export default 1', url: 'custom+app://session/main.mjs' }]
})

test('accepts canonical caller URLs and isolates the admitted source snapshot', () => {
  const input = base()
  input.argv = ['holonomy', '--fixture']
  input.env = { HOLONOMY_FIXTURE_URL: 'http://127.0.0.1:1234' }
  const normalized = normalizeNodeRuntimeSession(input)
  input.userModules[0].source = 'throw new Error()'
  input.argv[1] = '--mutated'
  input.env.HOLONOMY_FIXTURE_URL = 'http://invalid.example'

  assert.deepEqual(normalized.argv, ['holonomy', '--fixture'])
  assert.equal(normalized.entryUrl, 'custom+app://session/main.mjs')
  assert.equal(normalized.env.HOLONOMY_FIXTURE_URL, 'http://127.0.0.1:1234')
  assert.equal(normalized.userModules[0].source, 'export default 1')
  assert.ok(Object.isFrozen(normalized.argv))
  assert.ok(Object.isFrozen(normalized.env))
  assert.ok(Object.isFrozen(normalized.userModules))
})

test('binds every user module to one canonical graph root', () => {
  const input = {
    entryUrl: 'custom+app://session/.holonomy/entry.mjs',
    moduleRootUrl: 'custom+app://session/',
    userModules: [{ source: 'export default 1', url: 'custom+app://session/.holonomy/entry.mjs' }, {
      source: 'export default 2',
      url: 'custom+app://session/specs/example.mjs'
    }]
  }
  assert.equal(normalizeNodeRuntimeSession(input).moduleRootUrl, 'custom+app://session/')
  assert.throws(
    () => normalizeNodeRuntimeSession({ ...input, moduleRootUrl: 'custom+app://session/.holonomy/' }),
    /module root/u
  )
  assert.throws(() => normalizeNodeRuntimeSession({ ...input, moduleRootUrl: 'node:test/' }), /module root/u)
  assert.equal(
    normalizeNodeRuntimeSession({
      entryUrl: 'file:///workspace/main.mjs',
      moduleRootUrl: 'file:///workspace/',
      userModules: [{ source: 'export default 1', url: 'file:///workspace/main.mjs' }]
    }).moduleRootUrl,
    'file:///workspace/'
  )
  for (
    const moduleRootUrl of [
      'custom+app://session/a%2Fb/',
      'custom+app://session/a%5Cb/',
      'custom+app://session/a%00b/',
      'custom+app://session/a%xx/',
      'custom+app://session/a\\b/',
      `custom+app://session/a\0b/`
    ]
  ) {
    assert.throws(() => normalizeNodeRuntimeSession({ ...input, moduleRootUrl }), /module root/u)
  }
  for (
    const [moduleRootUrl, entryUrl] of [
      ['data:text/plain,root/', 'data:text/plain,root/main.mjs'],
      ['mailto:user@example.com/', 'mailto:user@example.com/main.mjs']
    ]
  ) {
    assert.throws(() =>
      normalizeNodeRuntimeSession({
        entryUrl,
        moduleRootUrl,
        userModules: [{ source: 'export default 1', url: entryUrl }]
      }), /module root/u)
  }
  assert.throws(() =>
    normalizeNodeRuntimeSession({
      ...input,
      entryUrl: 'custom+app://session/specs/main.mjs',
      moduleRootUrl: 'custom+app://session/specs/',
      userModules: [{ source: 'export default 1', url: 'custom+app://session/specs/main.mjs' }, {
        source: 'export default 1',
        url: 'custom+app://session/specs-other/example.mjs'
      }]
    }), /module root/u)
  assert.throws(() =>
    normalizeNodeRuntimeSession({
      ...input,
      userModules: [input.userModules[0], {
        source: 'export default 1',
        url: 'custom+app://other/specs/example.mjs'
      }]
    }), /module root/u)
  for (
    const url of [
      'data:text/javascript,export%20{}',
      'custom+app://session/a%2Fb/example.mjs',
      'custom+app://session/a%5Cb/example.mjs',
      'custom+app://session/a%00b/example.mjs'
    ]
  ) {
    assert.throws(() =>
      normalizeNodeRuntimeSession({
        ...input,
        userModules: [input.userModules[0], { source: 'export default 1', url }]
      }), /module root/u)
  }
})

test('bounds argv and environment snapshots', () => {
  assert.throws(
    () => normalizeNodeRuntimeSession({ ...base(), argv: Array.from({ length: 257 }, () => 'x') }),
    /argv/u
  )
  assert.throws(() => normalizeNodeRuntimeSession({ ...base(), argv: ['x'.repeat(16 * 1024 + 1)] }), /argv/u)
  assert.throws(() => normalizeNodeRuntimeSession({ ...base(), env: { 'BAD=KEY': 'value' } }), /env/u)
  assert.throws(
    () => normalizeNodeRuntimeSession({ ...base(), env: { LARGE: 'x'.repeat(64 * 1024 + 1) } }),
    /env/u
  )
})

test('reserves internal schemes and rejects unknown session controls', () => {
  const internal = base()
  internal.entryUrl = 'holonomy:///runtime/guest.mjs'
  internal.userModules[0].url = internal.entryUrl
  assert.throws(() => normalizeNodeRuntimeSession(internal), /Invalid Node Runtime user module URL/u)
  assert.throws(
    () => normalizeNodeRuntimeSession({ ...base(), authorityToken: 'guest' }),
    /Invalid Node Runtime session/u
  )
  assert.throws(() => normalizeNodeRuntimeSession({ ...base(), networkAuthority: {} }), /Invalid Node Runtime session/u)
  assert.throws(() => normalizeNodeRuntimeSession({ ...base(), inspector: { enabled: 'yes' } }), /inspector/u)
})

test('drops malformed and stale-generation child events', () => {
  const event = {
    generation: 3,
    protocolVersion: 1,
    requestId: 1,
    type: 'ack'
  }
  assert.equal(readChildEvent(event, 2), undefined)
  assert.equal(readChildEvent({ ...event, type: 'unknown' }, 3), undefined)
  assert.equal(readChildEvent(event, 3)?.requestId, 1)
})

test('shares strict bounded network-rule admission and rejects plaintext credentials', () => {
  const rules = {
    mode: 'failClosed',
    rules: [{
      action: { status: 200, type: 'respond' },
      id: 'profile',
      match: {
        headers: { entries: [['authorization', '<present>']], mode: 'subset' },
        method: 'GET',
        path: { op: 'exact', value: '/profile' }
      },
      priority: 1
    }]
  }
  assert.equal(
    JSON.stringify(
      normalizeNodeRuntimeSession({ ...base(), ...sandboxSession({ access: 'mockOnly' }), networkRules: rules })
        .networkRules
    ),
    JSON.stringify(rules)
  )
  assert.throws(() =>
    normalizeNodeRuntimeSession({
      ...base(),
      ...sandboxSession({ access: 'mockOnly' }),
      networkRules: {
        ...rules,
        rules: [{
          ...rules.rules[0],
          match: { ...rules.rules[0].match, headers: { entries: [['authorization', 'Bearer secret']], mode: 'subset' } }
        }]
      }
    }), /network rules/u)
  assert.throws(() =>
    normalizeNodeRuntimeSession({
      ...base(),
      ...sandboxSession({ access: 'mockOnly' }),
      networkRules: { ...rules, unexpected: true }
    }), /network rules/u)
  assert.throws(() =>
    normalizeNodeRuntimeSession({
      ...base(),
      ...sandboxSession(),
      networkRules: {
        mode: 'passthrough',
        rules: Array.from({ length: 256 }, (_, index) => ({
          action: { body: { kind: 'utf8', value: 'x'.repeat(4_096) }, status: 200, type: 'respond' },
          id: `rule-${index}`,
          match: {},
          priority: index
        }))
      }
    }), /limit/u)
})
