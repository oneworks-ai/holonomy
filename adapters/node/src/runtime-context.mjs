import { Buffer } from 'node:buffer'
import vm from 'node:vm'

import { installNodeEngineGateV1, reserveNodeEngineGateContextV1 } from './engine-gate-native.mjs'
import { HOST_FACADE_SOURCE, INSTALL_RUNTIME_GLOBALS } from './runtime-context-sources.mjs'

export { createContextValue, drainRuntimeLogs } from './runtime-context-values.mjs'

const INSTALL_WASM_FACADE = `(() => {
  const Native = WebAssembly
  const NativeArrayBuffer = ArrayBuffer
  const NativeDataView = DataView
  const NativeModule = Native.Module
  const NativeInstance = Native.Instance
  const NativeUint8Array = Uint8Array
  const ReflectApply = Reflect.apply
  const ReflectConstruct = Reflect.construct
  const ObjectDefineProperty = Object.defineProperty
  const ObjectFreeze = Object.freeze
  const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  const arrayBufferByteLength = ObjectGetOwnPropertyDescriptor(NativeArrayBuffer.prototype, 'byteLength').get
  const arrayBufferResizable = ObjectGetOwnPropertyDescriptor(NativeArrayBuffer.prototype, 'resizable')?.get
  const dataViewBuffer = ObjectGetOwnPropertyDescriptor(NativeDataView.prototype, 'buffer').get
  const dataViewByteLength = ObjectGetOwnPropertyDescriptor(NativeDataView.prototype, 'byteLength').get
  const dataViewByteOffset = ObjectGetOwnPropertyDescriptor(NativeDataView.prototype, 'byteOffset').get
  const typedArrayBuffer = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, 'buffer').get
  const typedArrayByteLength = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, 'byteLength').get
  const typedArrayByteOffset = ObjectGetOwnPropertyDescriptor(TypedArrayPrototype, 'byteOffset').get
  const typedArraySet = TypedArrayPrototype.set
  const moduleBytes = new WeakMap()
  const assertFixedArrayBuffer = buffer => {
    ReflectApply(arrayBufferByteLength, buffer, [])
    if (arrayBufferResizable != null && ReflectApply(arrayBufferResizable, buffer, [])) {
      throw new TypeError('Resizable WebAssembly source is unsupported')
    }
  }
  const copyBytes = (buffer, offset, length) => {
    assertFixedArrayBuffer(buffer)
    const view = ReflectConstruct(NativeUint8Array, [buffer, offset, length])
    const copy = ReflectConstruct(NativeUint8Array, [length])
    ReflectApply(typedArraySet, copy, [view])
    return copy
  }
  const snapshotSource = source => {
    try {
      const value = ReflectApply(arrayBufferByteLength, source, [])
      if (arrayBufferResizable != null && ReflectApply(arrayBufferResizable, source, [])) {
        throw new TypeError('Resizable WebAssembly source is unsupported')
      }
      if (Number.isSafeInteger(value) && value >= 0) return copyBytes(source, 0, value)
    } catch {}
    try {
      const value = ReflectApply(typedArrayByteLength, source, [])
      const offset = ReflectApply(typedArrayByteOffset, source, [])
      const buffer = ReflectApply(typedArrayBuffer, source, [])
      if (Number.isSafeInteger(value) && value >= 0) return copyBytes(buffer, offset, value)
    } catch {}
    try {
      const value = ReflectApply(dataViewByteLength, source, [])
      const offset = ReflectApply(dataViewByteOffset, source, [])
      const buffer = ReflectApply(dataViewBuffer, source, [])
      if (Number.isSafeInteger(value) && value >= 0) return copyBytes(buffer, offset, value)
    } catch {}
    throw new TypeError('WebAssembly source must be a non-shared BufferSource')
  }
  const stage = source => {
    const snapshot = snapshotSource(source)
    stageWasmSource(snapshot)
    return snapshot
  }
  const deny = () => { throw new Native.CompileError('Wasm code generation disallowed') }
  const Module = function Module(source) {
    if (new.target == null) throw new TypeError("WebAssembly.Module must be called with 'new'")
    const bytes = stage(source)
    const value = ReflectConstruct(NativeModule, [source], NativeModule)
    moduleBytes.set(value, bytes)
    return value
  }
  Module.prototype = NativeModule.prototype
  ObjectDefineProperty(NativeModule.prototype, 'constructor', { configurable: true, value: Module })
  for (const name of ['customSections', 'exports', 'imports']) {
    ObjectDefineProperty(Module, name, { value: (...args) => NativeModule[name](...args) })
  }
  const Instance = function Instance(module, imports) {
    if (new.target == null) throw new TypeError("WebAssembly.Instance must be called with 'new'")
    const source = moduleBytes.get(module)
    if (source == null || !requestWasm(source)) deny()
    return ReflectConstruct(NativeInstance, arguments.length > 1 ? [module, imports] : [module], NativeInstance)
  }
  Instance.prototype = NativeInstance.prototype
  ObjectDefineProperty(NativeInstance.prototype, 'constructor', { configurable: true, value: Instance })
  const compile = source => {
    const snapshot = stage(source)
    return Native.compile(source).then(module => {
      moduleBytes.set(module, snapshot)
      return module
    })
  }
  const instantiate = (source, imports) => {
    if (moduleBytes.has(source)) {
      if (!requestWasm(moduleBytes.get(source))) deny()
      return Native.instantiate(source, imports)
    }
    const snapshot = stage(source)
    return Native.instantiate(source, imports).then(result => {
      if (result?.module != null) moduleBytes.set(result.module, snapshot)
      return result
    })
  }
  const readStreaming = async source => {
    const response = await source
    if (response == null || typeof response.arrayBuffer !== 'function') {
      throw new TypeError('WebAssembly streaming source must resolve to a Response')
    }
    return await response.arrayBuffer()
  }
  ObjectDefineProperty(globalThis, 'WebAssembly', {
    configurable: false,
    enumerable: false,
    value: ObjectFreeze({
      CompileError: Native.CompileError,
      Global: Native.Global,
      Instance,
      LinkError: Native.LinkError,
      Memory: Native.Memory,
      Module,
      RuntimeError: Native.RuntimeError,
      Table: Native.Table,
      compile,
      compileStreaming: source => readStreaming(source).then(compile),
      instantiate,
      instantiateStreaming: (source, imports) => readStreaming(source).then(bytes => instantiate(bytes, imports)),
      validate: source => Native.validate(source)
    }),
    writable: false
  })
})()`

export function createRuntimeContext(name = 'holonomy-runtime', codeGeneration = undefined) {
  const sandbox = Object.create(null)
  const engineGateContextId = reserveNodeEngineGateContextV1(sandbox)
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
    name
  })
  const engineGate = installNodeEngineGateV1(engineGateContextId, codeGeneration)
  if (engineGate.stageWasmSource != null && engineGate.requestWasm != null) {
    const installWasmFacade = vm.compileFunction(`return ${INSTALL_WASM_FACADE}`, [], {
      contextExtensions: [Object.freeze({
        requestWasm: engineGate.requestWasm,
        stageWasmSource: engineGate.stageWasmSource
      })],
      filename: 'holonomy:///runtime/wasm-gate-bootstrap.mjs',
      parsingContext: context
    })
    installWasmFacade()
  }
  const controls = vm.runInContext(INSTALL_RUNTIME_GLOBALS, context, {
    filename: 'holonomy:///runtime/context-bootstrap.mjs'
  })
  return Object.freeze({ context, controls, engineGate })
}

export function createNativeEventValue(runtimeContext, event) {
  const serializable = event.binary == null
    ? event
    : {
      ...event,
      binary: event.binary.map(handle => ({
        dataBase64: Buffer.from(handle.data.buffer, handle.data.byteOffset, handle.data.byteLength).toString('base64'),
        handle: handle.handle
      }))
    }
  return runtimeContext.controls.parseNativeEvent(JSON.stringify(serializable))
}

export function installRuntimeHostBridge(runtimeContext, operations) {
  const dispatch = (name, args) => {
    try {
      const operation = operations[name]
      return typeof operation === 'function' ? operation(...args) : null
    } catch (error) {
      operations.onError?.(name, error)
      return null
    }
  }
  const factory = vm.compileFunction(`return ${HOST_FACADE_SOURCE}`, [], {
    contextExtensions: [Object.freeze({ dispatch })],
    filename: 'holonomy:///runtime/node-host-facade.mjs',
    parsingContext: runtimeContext.context
  })
  const facade = factory()
  Object.defineProperty(runtimeContext.context, '__holonomyNodeHost', {
    configurable: true,
    enumerable: false,
    value: facade,
    writable: false
  })
}
