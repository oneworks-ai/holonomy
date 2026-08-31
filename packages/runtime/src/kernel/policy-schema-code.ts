import { integerSchema, noneSchema, strictObject } from './schema-primitives.js'

const codeKind = Object.freeze({
  oneOf: [
    noneSchema,
    strictObject({
      access: { const: 'controlled' },
      decisionTimeoutMs: integerSchema(1, 120_000),
      maxOperations: integerSchema(1, 100_000),
      maxSourceBytes: integerSchema(1, 16 * 1024 * 1024)
    })
  ]
})

export const CODE_GENERATION_SANDBOX_V2_SCHEMA = strictObject({
  dynamicImport: codeKind,
  strings: codeKind,
  wasm: codeKind
})

export const INSPECTOR_SANDBOX_V2_SCHEMA = strictObject({
  callFunctionOn: { type: 'boolean' },
  compileScript: { type: 'boolean' },
  evaluate: { type: 'boolean' },
  runScript: { type: 'boolean' },
  setScriptSource: { type: 'boolean' }
}, [])
