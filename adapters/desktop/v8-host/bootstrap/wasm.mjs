import { readWasmStreamingResponse } from '../../../../packages/capabilities/network/src/web/web-response.ts'

// Source bytes are validated and copied by Rust; this wrapper brackets the
// immediate call into the captured V8 API after any trusted Response read.
export const installNativeWasm = host => {
  const Native = globalThis.WebAssembly
  const NativeModule = Native.Module
  const NativeCompile = Native.compile
  const NativeInstantiate = Native.instantiate
  const ReflectApply = Reflect.apply
  const ReflectConstruct = Reflect.construct
  const ObjectDefineProperty = Object.defineProperty
  const ObjectFreeze = Object.freeze
  // Matches the Engine Gate metadata ceiling; Rust enforces this again before
  // staging, and the selected Policy can impose a smaller source limit.
  const MAX_STREAMING_BYTES = 16 * 1024 * 1024

  const invokeStaged = (operation, source, invoke) => {
    const token = host.wasmStage(operation, source)
    if (token === null) return invoke()
    try {
      return invoke()
    } finally {
      host.wasmClear(token)
    }
  }

  const Module = function Module(source) {
    if (new.target == null) throw new TypeError("WebAssembly.Module must be called with 'new'")
    return invokeStaged(0, source, () => ReflectConstruct(NativeModule, [source], new.target))
  }
  Module.prototype = NativeModule.prototype
  ObjectDefineProperty(NativeModule.prototype, 'constructor', {
    configurable: false,
    value: Module,
    writable: false
  })
  for (const name of ['customSections', 'exports', 'imports']) {
    const method = NativeModule[name]
    ObjectDefineProperty(Module, name, {
      value: (...args) => ReflectApply(method, NativeModule, args)
    })
  }

  const invokeAsync = async (operation, source, invoke) => {
    const work = host.wasmBeginAsync()
    try {
      return await invokeStaged(operation, source, invoke)
    } finally {
      host.wasmEndAsync(work)
    }
  }
  const compile = source => invokeAsync(1, source, () => ReflectApply(NativeCompile, Native, [source]))
  const instantiate = (source, imports) =>
    invokeAsync(2, source, () => ReflectApply(NativeInstantiate, Native, [source, imports]))
  const invokeStreaming = async (operation, source, invoke) => {
    // This liveness lease begins before Promise<Response> resolution and closes
    // on every read, Gate, V8 compilation, cancellation, or rejection path.
    const work = host.wasmBeginAsync()
    try {
      const response = await source
      const bytes = await readWasmStreamingResponse(response, MAX_STREAMING_BYTES)
      return await invokeStaged(operation, bytes, () => invoke(bytes))
    } finally {
      host.wasmEndAsync(work)
    }
  }
  const compileStreaming = source => invokeStreaming(1, source, bytes => ReflectApply(NativeCompile, Native, [bytes]))
  const instantiateStreaming = (source, imports) =>
    invokeStreaming(2, source, bytes => ReflectApply(NativeInstantiate, Native, [bytes, imports]))

  ObjectDefineProperty(globalThis, 'WebAssembly', {
    configurable: false,
    enumerable: false,
    value: ObjectFreeze({
      CompileError: Native.CompileError,
      Global: Native.Global,
      Instance: Native.Instance,
      LinkError: Native.LinkError,
      Memory: Native.Memory,
      Module,
      RuntimeError: Native.RuntimeError,
      Table: Native.Table,
      compile,
      compileStreaming,
      instantiate,
      instantiateStreaming,
      validate: source => ReflectApply(Native.validate, Native, [source])
    }),
    writable: false
  })
}
