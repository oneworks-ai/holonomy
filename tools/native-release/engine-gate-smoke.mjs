import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sha256 } from './manifest.mjs'

const marker = 'HOLO_NATIVE_ENGINE_GATES_OK\n'
const bytecode = [
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  5,
  1,
  96,
  0,
  1,
  127,
  3,
  2,
  1,
  0,
  7,
  7,
  1,
  3,
  114,
  117,
  110,
  0,
  0,
  10,
  6,
  1,
  4,
  0,
  65,
  42,
  11
]
const wasmDigest = sha256(new Uint8Array(bytecode))
const program = `import assert from 'node:assert/strict'
assert.equal(process.versions.node, undefined)
const bytes = new Uint8Array(${JSON.stringify(bytecode)})
const module = new WebAssembly.Module(bytes)
assert.ok(module instanceof WebAssembly.Module)
assert.equal(new WebAssembly.Instance(module).exports.run(), 42)
assert.throws(() => new WebAssembly.Module(bytes))
assert.equal((await import('./lazy.mjs')).value, 42)
assert.equal(globalThis.moduleRuns, 1)
await assert.rejects(import('./lazy.mjs'))
assert.equal(globalThis.moduleRuns, 1)
assert.equal(typeof globalThis.__holoControlHost, 'undefined')
console.log('HOLO_NATIVE_ENGINE_GATES_OK')
`
const plugin = `export default context => {
  const calls = new Map()
  context.holo.engineGate(request => {
    const operation = request.operation
    if (!['runtime.code.generate.wasm', 'runtime.module.import'].includes(operation)) {
      return { action: 'deny', reasonCode: 'artifact.unexpected_operation' }
    }
    if (operation === 'runtime.code.generate.wasm' &&
        (request.sourceBytes !== ${bytecode.length} || request.sourceSha256 !== '${wasmDigest}')) {
      return { action: 'deny', reasonCode: 'artifact.unexpected_source' }
    }
    if (operation === 'runtime.module.import' && request.origin !== 'app://workspace/lazy.mjs') {
      return { action: 'deny', reasonCode: 'artifact.unexpected_origin' }
    }
    const count = (calls.get(operation) ?? 0) + 1
    calls.set(operation, count)
    return count === 1 ? { action: 'allow' } : { action: 'deny', reasonCode: 'artifact.second_denied' }
  })
}
`

// `run` is the packaging owner's fixed empty-PATH runner. This helper admits no
// executable override, imports or configuration from the artifact consumer.
export const verifyNativeEngineGates = async ({ directory, executable, run }) => {
  await mkdir(directory)
  const controlled = {
    access: 'controlled',
    decisionTimeoutMs: 500,
    maxOperations: 4,
    maxSourceBytes: 4096
  }
  await writeFile(
    join(directory, 'host.json'),
    JSON.stringify({
      schemaVersion: 1,
      sandboxPolicy: {
        schemaVersion: 2,
        codeGeneration: {
          strings: { access: 'none' },
          wasm: controlled,
          dynamicImport: controlled
        }
      },
      plugins: [{ id: 'artifact-gate', use: './plugin.mjs' }]
    }),
    { mode: 0o600 }
  )
  await writeFile(join(directory, 'plugin.mjs'), plugin, { mode: 0o600 })
  await writeFile(join(directory, 'entry.mjs'), program)
  await writeFile(
    join(directory, 'lazy.mjs'),
    'globalThis.moduleRuns = (globalThis.moduleRuns ?? 0) + 1; export const value = 42;\n'
  )
  const stdout = run(executable, ['--timeout', '3000', '--host-config', './host.json', './entry.mjs'], directory)
  if (stdout !== marker) throw new Error('Relocated native Engine Gate smoke failed')
  return Object.freeze({
    status: 'passed',
    command: 'holo --timeout 3000 --host-config host.json entry.mjs',
    stdout: marker,
    checks: Object.freeze([
      'wasm.execute-allow-deny',
      'dynamic-import.allow-deny',
      'cached-import.no-second-side-effect'
    ])
  })
}
