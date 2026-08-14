import { invalidPolicy } from './errors.js'
import type { CodeGenerationSandboxV2, CodeKindPolicyV2, InspectorSandboxV2 } from './policy-types.js'
import { boolean, exact, integer, literal, required } from './validation.js'

const codeKind = (value: unknown): CodeKindPolicyV2 => {
  const input = exact(value, ['access', 'decisionTimeoutMs', 'maxOperations', 'maxSourceBytes'])
  const access = literal(required(input, 'access'), ['controlled', 'none'] as const)
  if (access === 'none') {
    if (Object.keys(input).length !== 1) return invalidPolicy()
    return Object.freeze({ access })
  }
  return Object.freeze({
    access,
    decisionTimeoutMs: integer(required(input, 'decisionTimeoutMs'), 1, 120_000),
    maxOperations: integer(required(input, 'maxOperations'), 1, 100_000),
    maxSourceBytes: integer(required(input, 'maxSourceBytes'), 1, 16 * 1024 * 1024)
  })
}

export const normalizeCodeGenerationSandbox = (value: unknown): CodeGenerationSandboxV2 => {
  const input = exact(value, ['dynamicImport', 'strings', 'wasm'])
  return Object.freeze({
    dynamicImport: codeKind(required(input, 'dynamicImport')),
    strings: codeKind(required(input, 'strings')),
    wasm: codeKind(required(input, 'wasm'))
  })
}

const INSPECTOR_KEYS = [
  'callFunctionOn',
  'compileScript',
  'evaluate',
  'runScript',
  'setScriptSource'
] as const

export const normalizeInspectorSandbox = (value: unknown): InspectorSandboxV2 => {
  const input = exact(value, INSPECTOR_KEYS)
  return Object.freeze({
    callFunctionOn: Object.hasOwn(input, 'callFunctionOn') ? boolean(input.callFunctionOn) : false,
    compileScript: Object.hasOwn(input, 'compileScript') ? boolean(input.compileScript) : false,
    evaluate: Object.hasOwn(input, 'evaluate') ? boolean(input.evaluate) : false,
    runScript: Object.hasOwn(input, 'runScript') ? boolean(input.runScript) : false,
    setScriptSource: Object.hasOwn(input, 'setScriptSource') ? boolean(input.setScriptSource) : false
  })
}
