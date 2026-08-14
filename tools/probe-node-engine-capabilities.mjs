import process from 'node:process'
import vm from 'node:vm'

const evaluate = (source, codeGeneration) => {
  const context = vm.createContext(Object.create(null), {
    codeGeneration
  })
  try {
    vm.runInContext(source, context)
    return 'completed'
  } catch {
    return 'rejected'
  }
}

const evalSource = 'eval("1 + 1"); Function("return 1")()'
const wasmSource = 'new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))'
const allowed = { strings: true, wasm: true }
const denied = { strings: false, wasm: false }
const stringsControl = evaluate(evalSource, allowed) === 'completed'
const stringsDenied = stringsControl && evaluate(evalSource, denied) === 'rejected'
const wasmControl = evaluate(wasmSource, allowed) === 'completed'
const wasmDenied = wasmControl && evaluate(wasmSource, denied) === 'rejected'

const probe = {
  engine: 'node-vm',
  metadata: {
    callsite: 'unavailable',
    entryDetail: 'unavailable',
    origin: 'unavailable',
    source: 'unavailable'
  },
  provenance: {
    generationLevel: 'behavioralProbe',
    metadata: 'profileStaticUnsupported',
    perCompilationCallback: 'profileStaticUnsupported'
  },
  schemaVersion: 1,
  strings: {
    generationLevelDeny: stringsDenied,
    perCompilationCallback: false
  },
  wasm: {
    generationLevelDeny: wasmDenied,
    perCompilationCallback: false
  }
}

if (!stringsDenied || !wasmDenied) {
  throw new Error('Node VM code-generation capability probe failed closed')
}
process.stdout.write(`${JSON.stringify(probe)}\n`)
