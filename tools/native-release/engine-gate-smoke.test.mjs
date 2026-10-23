/* eslint-disable test/no-import-node-test -- Build-tool tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { verifyNativeEngineGates } from './engine-gate-smoke.mjs'

const fixture = async context => {
  const parent = await mkdtemp(join(tmpdir(), 'holo-gate-smoke-test-'))
  context.after(() => rm(parent, { recursive: true, force: true }))
  return join(parent, 'owned-smoke')
}

test('packaging Gate smoke selects bounded Policy and a Host-only allow/deny plugin', async context => {
  const directory = await fixture(context)
  let calls = 0
  const result = await verifyNativeEngineGates({
    directory,
    executable: '/test-only/delivered-holo',
    run: (binary, args, cwd) => {
      calls++
      assert.equal(binary, '/test-only/delivered-holo')
      assert.equal(cwd, directory)
      assert.deepEqual(args, ['--timeout', '3000', '--host-config', './host.json', './entry.mjs'])
      return 'HOLO_NATIVE_ENGINE_GATES_OK\n'
    }
  })
  assert.equal(calls, 1)
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.checks, [
    'wasm.execute-allow-deny',
    'dynamic-import.allow-deny',
    'cached-import.no-second-side-effect'
  ])
  const config = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'))
  assert.equal(config.sandboxPolicy.codeGeneration.strings.access, 'none')
  assert.deepEqual(config.sandboxPolicy.codeGeneration.wasm, {
    access: 'controlled',
    decisionTimeoutMs: 500,
    maxOperations: 4,
    maxSourceBytes: 4096
  })
  assert.deepEqual(config.sandboxPolicy.codeGeneration.dynamicImport, config.sandboxPolicy.codeGeneration.wasm)
  assert.deepEqual(config.plugins, [{ id: 'artifact-gate', use: './plugin.mjs' }])
  const entry = await readFile(join(directory, 'entry.mjs'), 'utf8')
  assert(entry.includes("await assert.rejects(import('./lazy.mjs'))"))
  assert(entry.includes('assert.throws(() => new WebAssembly.Module(bytes))'))
})

test('missing, duplicate and changed Gate smoke terminal cannot report passed', async context => {
  for (const stdout of ['', 'HOLO_NATIVE_ENGINE_GATES_OK', 'HOLO_NATIVE_ENGINE_GATES_OK\n'.repeat(2)]) {
    const directory = await fixture(context)
    await assert.rejects(
      verifyNativeEngineGates({ directory, executable: '/test-only/holo', run: () => stdout }),
      /Engine Gate smoke failed/u
    )
  }
})

test('owned Gate fixture never overwrites an existing destination', async context => {
  const directory = await fixture(context)
  await writeFile(directory, 'user-owned')
  let invoked = false
  await assert.rejects(verifyNativeEngineGates({
    directory,
    executable: '/test-only/holo',
    run: () => {
      invoked = true
    }
  }))
  assert.equal(invoked, false)
  assert.equal(await readFile(directory, 'utf8'), 'user-owned')
})

test('runner failure remains a failed Gate verification', async context => {
  const directory = await fixture(context)
  const failure = new Error('test-only failed executable')
  await assert.rejects(
    verifyNativeEngineGates({
      directory,
      executable: '/test-only/holo',
      run: () => {
        throw failure
      }
    }),
    error => error === failure
  )
})
