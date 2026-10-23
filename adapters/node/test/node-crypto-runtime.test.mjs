import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'
import vm from 'node:vm'

import { installNodeCryptoBridge } from '../src/node-crypto-bridge.mjs'
import { createRuntimeContext } from '../src/runtime-context.mjs'
import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'

const session = source => ({
  entryUrl: 'app://crypto/main.mjs',
  userModules: [{ source, url: 'app://crypto/main.mjs' }]
})

test('defaults to no crypto and only the Host constructor can opt in', async t => {
  const denied = new NodeRuntimeSupervisor()
  t.after(() => denied.stop())
  const logs = []
  denied.on('log', event => logs.push(event.text))
  await denied.start({ ...session("console.log('CRYPTO:' + typeof crypto)"), crypto: { enabled: true } })
  assert.ok(logs.includes('CRYPTO:undefined'))
  await denied.stop()
  await assert.rejects(() => denied.start(session("import { randomBytes } from 'node:crypto'; randomBytes(1)")))
})

test('runs the unchanged shared crypto conformance through a real Supervisor child', async t => {
  const supervisor = new NodeRuntimeSupervisor({ crypto: { enabled: true }, requestTimeoutMs: 20_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))
  const source = await readFile(
    new URL('../../../conformance/capabilities/crypto-v1.test.mjs', import.meta.url),
    'utf8'
  )
  const entry = session(
    "import './crypto-case.mjs'; import { run } from 'node:test'; console.log('RESULT:' + JSON.stringify(await run()))"
  )
  const input = {
    ...entry,
    userModules: [
      ...entry.userModules,
      { source, url: 'app://crypto/crypto-case.mjs' }
    ]
  }
  const first = await supervisor.start(input)
  const result = logs.find(event => event.text.startsWith('RESULT:'))
  assert.ok(result, JSON.stringify(logs))
  const summary = JSON.parse(result.text.slice(7))
  t.diagnostic(`Shared crypto conformance: ${JSON.stringify(summary)}`)
  assert.equal(summary.failed, 0, JSON.stringify(summary))
  assert.equal(summary.passed, 6, JSON.stringify(summary))
  const next = await supervisor.restart(session(`
    import { createHash } from 'node:crypto'
    const contexts = Array.from({ length: 64 }, () => createHash('sha256'))
    let quota
    try { createHash('sha256') } catch (error) { quota = error.code }
    console.log('FRESH:' + contexts.length + ':' + quota + ':' + typeof crypto.getRandomValues)
  `))
  assert.notEqual(first.pid, next.pid)
  assert.equal(next.generation, 2)
  assert.ok(
    logs.some(event => event.generation === 2 && event.text === 'FRESH:64:ERR_HOLONOMY_RESOURCE_EXHAUSTED:function')
  )
})

test('keeps Guest binary Proxy/getter/constructor/thenable side effects at zero', async t => {
  const supervisor = new NodeRuntimeSupervisor({ crypto: { enabled: true } })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(session(`
    import assert from 'node:assert/strict'
    import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
    let sideEffects = 0
    const trap = () => { sideEffects++; throw new Error('Guest callback') }
    const input = new Uint8Array([97, 98, 99])
    for (const key of ['buffer', 'byteLength', 'byteOffset', 'length', 'constructor', 'then']) {
      Object.defineProperty(input, key, { get: trap })
    }
    const proxy = new Proxy(input, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
    assert.throws(() => createHash('sha256').update(proxy))
    assert.throws(() => createHmac('sha256', proxy))
    assert.throws(() => timingSafeEqual(input, proxy))
    assert.throws(() => crypto.getRandomValues(proxy))
    assert.equal(createHash('sha256').update(input).digest('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const thenable = { get then() { return trap() } }
    assert.throws(() => createHash('sha256').update(thenable))
    assert.throws(() => createHash(proxy))
    assert.throws(() => createHash('sha512'), { code: 'ERR_CRYPTO_UNKNOWN_HASH' })
    assert.equal(crypto.subtle, undefined)
    const output = randomBytes(8)
    assert.equal(output instanceof Uint8Array, true)
    assert.equal(Object.getPrototypeOf(createHash).constructor, Function)
    assert.throws(() => createHash.constructor('return process')())
    assert.equal(globalThis.__holonomyNodeCryptoProvider, undefined)
    assert.equal(globalThis.__holonomyNodeHost, undefined)
    assert.equal(sideEffects, 0)
    console.log('SECURE:' + sideEffects)
  `))
  assert.ok(logs.includes('SECURE:0'), JSON.stringify(logs))
})

test('Host dispose synchronously invalidates every retained Guest provider operation', () => {
  const context = createRuntimeContext()
  const control = installNodeCryptoBridge(context)
  vm.runInContext(
    `
    globalThis.provider = __holonomyNodeCryptoProvider
    delete globalThis.__holonomyNodeCryptoProvider
    globalThis.retained = provider.createContext({ kind: 'hash', algorithm: 'sha256' })
    provider.update(retained, new Uint8Array([97]))
  `,
    context.context
  )
  control.dispose()
  control.dispose()
  assert.throws(() => vm.runInContext('provider.digest(retained)', context.context), /Crypto operation failed/u)
  assert.throws(() => vm.runInContext('provider.randomBytes(1)', context.context), /Crypto operation failed/u)
  const fresh = createRuntimeContext()
  const freshControl = installNodeCryptoBridge(fresh)
  fresh.context.foreign = vm.runInContext('retained', context.context)
  assert.throws(
    () => vm.runInContext('__holonomyNodeCryptoProvider.update(foreign, new Uint8Array(1))', fresh.context),
    /Crypto operation failed/u
  )
  assert.equal(vm.runInContext('__holonomyNodeCryptoProvider.randomBytes(1).length', fresh.context), 1)
  freshControl.dispose()
})

test('uses captured Guest primitives after constructors, iterators and builtins are poisoned', async t => {
  const supervisor = new NodeRuntimeSupervisor({ crypto: { enabled: true } })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(session(`
    import assert from 'node:assert/strict'
    import { createHash, createCipheriv, randomBytes } from 'node:crypto'
    const input = new Uint8Array([97, 98, 99])
    const key = new Uint8Array(32)
    const iv = new Uint8Array(12)
    const properties = [
      [globalThis, 'Uint8Array'], [JSON, 'parse'], [Reflect, 'apply'],
      [WeakMap.prototype, 'get'], [WeakMap.prototype, 'set'], [WeakMap.prototype, 'delete'],
      [Array.prototype, Symbol.iterator], [String.prototype, 'slice'],
      [Object.getPrototypeOf(Uint8Array.prototype), 'constructor']
    ]
    const descriptors = properties.map(([object, name]) => Object.getOwnPropertyDescriptor(object, name))
    let sideEffects = 0
    const trap = () => { sideEffects++; throw new Error('Guest callback') }
    let digest, randomLength, finalLength, tagLength
    try {
      for (let i = 0; i < properties.length; i++) {
        Object.defineProperty(properties[i][0], properties[i][1], { configurable: true, get: trap })
      }
      digest = createHash('sha256').update(input).digest('hex')
      randomLength = randomBytes(8).length
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.update(input)
      finalLength = cipher.final().length
      tagLength = cipher.getAuthTag().length
    } finally {
      for (let i = 0; i < properties.length; i++) {
        const object = properties[i][0], name = properties[i][1]
        if (descriptors[i]) Object.defineProperty(object, name, descriptors[i])
        else delete object[name]
      }
    }
    assert.equal(sideEffects, 0)
    assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    assert.equal(randomLength, 8)
    assert.equal(finalLength, 0)
    assert.equal(tagLength, 16)
    console.log('POISON:0')
  `))
  assert.ok(logs.includes('POISON:0'), JSON.stringify(logs))
})

test('clears the intermediate Host encoding copy on success and conversion failure', () => {
  const runtime = createRuntimeContext()
  const control = installNodeCryptoBridge(runtime)
  const originalFrom = Buffer.from
  const copies = []
  let failConversion = false
  try {
    Buffer.from = function(source, ...args) {
      const copy = Reflect.apply(originalFrom, Buffer, [source, ...args])
      copies.push({ copy, source })
      if (failConversion) {
        copy.toString = () => {
          throw new Error('Host detail must stay private')
        }
      }
      return copy
    }
    const digest = vm.runInContext(
      `
      const provider = __holonomyNodeCryptoProvider
      const context = provider.createContext({ kind: 'hash', algorithm: 'sha256' })
      provider.update(context, new Uint8Array([97, 98, 99]))
      provider.digest(context)
    `,
      runtime.context
    )
    assert.equal(digest.length, 32)
    assert.equal(digest[0], 0xBA)
    failConversion = true
    assert.throws(
      () => vm.runInContext('provider.randomBytes(16)', runtime.context),
      /Crypto operation failed/u
    )
  } finally {
    Buffer.from = originalFrom
    control.dispose()
  }
  assert.equal(copies.length, 3)
  for (const { copy, source } of copies) {
    assert.notEqual(copy, source)
    const overlaps = copy.buffer === source.buffer &&
      copy.byteOffset < source.byteOffset + source.byteLength &&
      source.byteOffset < copy.byteOffset + copy.byteLength
    assert.equal(overlaps, false)
    assert.equal(copy.every(byte => byte === 0), true)
    assert.equal(source.every(byte => byte === 0), true)
  }
})
