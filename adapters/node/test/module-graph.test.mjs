import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { SessionModuleGraph } from '../src/module-graph.mjs'
import { createRuntimeContext, drainRuntimeLogs } from '../src/runtime-context.mjs'
import { normalizeNodeRuntimeSession } from '../src/session-validation.mjs'

const session = overrides =>
  normalizeNodeRuntimeSession({
    entryUrl: 'app://fixture/main.mjs',
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{ source: '', url: 'app://fixture/main.mjs' }],
    ...overrides
  })

test('evaluates only the supplied graph without ambient Node globals', async () => {
  const runtime = createRuntimeContext()
  const graph = new SessionModuleGraph(
    runtime,
    session({
      syntheticModules: { 'node:fixture': { settings: { enabled: true } } },
      userModules: [{
        source: `
        import { settings } from 'node:fixture'
        console.log(JSON.stringify({
          buffer: typeof Buffer,
          constructorEscape: (() => { try { globalThis.constructor.constructor('return process')(); return true } catch { return false } })(),
          fetch: typeof fetch,
          frozen: Object.isFrozen(settings),
          process: typeof process,
          require: typeof require,
          url: import.meta.url
        }))
      `,
        url: 'app://fixture/main.mjs'
      }]
    })
  )

  await graph.evaluateEntry()

  assert.deepEqual(JSON.parse(drainRuntimeLogs(runtime)[0].text), {
    buffer: 'undefined',
    constructorEscape: false,
    fetch: 'undefined',
    frozen: true,
    process: 'undefined',
    require: 'undefined',
    url: 'app://fixture/main.mjs'
  })
})

test('rejects imports outside the session and user imports of runtime internals', async () => {
  const missing = new SessionModuleGraph(
    createRuntimeContext(),
    session({
      userModules: [{ source: "import './missing.mjs'", url: 'app://fixture/main.mjs' }]
    })
  )
  await assert.rejects(() => missing.evaluateEntry(), /outside the session graph/u)

  const internal = new SessionModuleGraph(
    createRuntimeContext(),
    session({
      runtimeModules: [{ source: 'export const hidden = true', url: 'holonomy:///runtime/hidden.mjs' }],
      userModules: [{
        source: "import 'holonomy:///runtime/hidden.mjs'",
        url: 'app://fixture/main.mjs'
      }]
    })
  )
  await assert.rejects(() => internal.evaluateEntry(), /cannot import Node Runtime internals/u)
})

test('allows runtime internals to compose the explicit user graph', async () => {
  const runtime = createRuntimeContext()
  const graph = new SessionModuleGraph(
    runtime,
    session({
      entryUrl: 'holonomy:///runtime/bootstrap.mjs',
      runtimeModules: [{
        source: "import { value } from 'app://fixture/value.mjs'; console.log(value)",
        url: 'holonomy:///runtime/bootstrap.mjs'
      }],
      userEntryUrl: 'app://fixture/main.mjs',
      userModules: [
        { source: "import 'holonomy:///runtime/bootstrap.mjs'", url: 'app://fixture/main.mjs' },
        { source: "export const value = 'composed'", url: 'app://fixture/value.mjs' }
      ]
    })
  )

  await graph.evaluateEntry()
  assert.equal(JSON.stringify(drainRuntimeLogs(runtime)), JSON.stringify([{ level: 'log', text: 'composed' }]))
})
