import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { createSupervisorProcessEnvironmentFactoryV1 } from './capability-process-supervisor-environment.mjs'

const invalid = () => {
  throw new TypeError('Invalid v86 Process environment')
}

const waitForReady = (vm, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    let abort
    let ready
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      vm.remove_listener('emulator-ready', ready)
    }
    const fail = () => {
      cleanup()
      reject(new TypeError('Invalid v86 Process environment'))
    }
    abort = () => fail()
    ready = () => {
      cleanup()
      resolve()
    }
    timer = setTimeout(fail, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    vm.add_listener('emulator-ready', ready)
    if (signal.aborted) abort()
  })

const verifiedBuffer = async (loadArtifact, artifact) => {
  const value = await loadArtifact(artifact)
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : value instanceof Uint8Array
    ? value
    : invalid()
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256) return invalid()
  return Uint8Array.from(bytes).buffer
}

const v86Options = async (configuration, V86, loadArtifact, networkEnabled) => {
  const { artifacts } = configuration
  const [bios, initialState, initrd, kernel, wasm] = await Promise.all([
    verifiedBuffer(loadArtifact, artifacts.bios),
    artifacts.initialState == null ? undefined : verifiedBuffer(loadArtifact, artifacts.initialState),
    verifiedBuffer(loadArtifact, artifacts.initrd),
    verifiedBuffer(loadArtifact, artifacts.kernel),
    verifiedBuffer(loadArtifact, artifacts.wasm)
  ])
  return {
    V86,
    options: {
      autostart: !networkEnabled,
      bios: { buffer: bios },
      bzimage: { buffer: kernel },
      cmdline:
        'tsc=reliable mitigations=off random.trust_cpu=on earlyprintk=serial,ttyS0,115200 console=ttyS0 audit=0 rdinit=/holo-supervisor',
      disable_keyboard: true,
      disable_mouse: true,
      disable_speaker: true,
      filesystem: {},
      ...(initialState == null ? {} : { initial_state: { buffer: initialState } }),
      initrd: { buffer: initrd },
      memory_size: configuration.memoryBytes,
      ...(networkEnabled ? { net_device: { relay_url: 'fetch', type: 'virtio' } } : {}),
      screen: { container: null },
      uart1: true,
      wasm_fn: async imports => (await WebAssembly.instantiate(wasm, imports)).instance.exports
    }
  }
}

export const createV86ProcessEnvironmentFactoryV1 = options => {
  if (
    (typeof options?.V86 !== 'function' && typeof options?.loadV86 !== 'function') ||
    typeof options?.loadArtifact !== 'function' ||
    options.readyTimeoutMs != null && !Number.isInteger(options.readyTimeoutMs) ||
    options.handleFilesystemRequest != null && typeof options.handleFilesystemRequest !== 'function' ||
    options.handleNetworkRequest != null && typeof options.handleNetworkRequest !== 'function' ||
    options.onKernelCapabilities != null && typeof options.onKernelCapabilities !== 'function'
  ) return invalid()
  return createSupervisorProcessEnvironmentFactoryV1({
    ...(options.handleFilesystemRequest == null
      ? {}
      : { handleFilesystemRequest: options.handleFilesystemRequest }),
    readyTimeoutMs: options.readyTimeoutMs,
    validateReady(environment, request) {
      if (
        request.configuration.requiredKernelCapabilities.some(
          capability => !environment.kernelCapabilities.includes(capability)
        )
      ) return invalid()
      options.onKernelCapabilities?.(environment.kernelCapabilities, request)
    },
    async openTransport(request) {
      const V86 = options.V86 ?? await options.loadV86()
      if (typeof V86 !== 'function') return invalid()
      const prepared = await v86Options(
        request.configuration,
        V86,
        options.loadArtifact,
        options.handleNetworkRequest != null
      )
      const vm = new prepared.V86(prepared.options)
      try {
        if (options.handleNetworkRequest != null) {
          const installNetworkBridge = () => {
            if (typeof vm.network_adapter?.fetch !== 'function') return false
            vm.network_adapter.fetch = (url, init) => {
              const source = request.resolveProcessSource()
              return options.handleNetworkRequest(Object.freeze({
                environmentId: request.environmentId,
                executableId: source.executableId,
                generation: request.generation,
                init,
                linuxPid: source.linuxPid,
                policy: request.policy,
                processId: source.processId,
                processResourceId: source.processResourceId,
                scope: request.scope,
                signal: request.signal,
                url: String(url)
              }))
            }
            return true
          }
          if (!installNetworkBridge()) {
            await waitForReady(vm, options.readyTimeoutMs ?? 30_000, request.signal)
            if (!installNetworkBridge()) return invalid()
          }
        }
      } catch (error) {
        await Promise.resolve(vm.destroy()).catch(() => undefined)
        throw error
      }
      let closed = false
      const output = byte => request.onBytes(Uint8Array.of(byte))
      const downloadError = () => request.onError()
      const stopped = () => request.onClose()
      vm.add_listener('serial1-output-byte', output)
      vm.add_listener('download-error', downloadError)
      vm.add_listener('emulator-stopped', stopped)
      return {
        async close() {
          if (closed) return
          closed = true
          vm.remove_listener('serial1-output-byte', output)
          vm.remove_listener('download-error', downloadError)
          vm.remove_listener('emulator-stopped', stopped)
          await vm.destroy()
        },
        ...(options.handleNetworkRequest == null
          ? {}
          : {
            start() {
              vm.run?.()
            }
          }),
        async write(bytes) {
          if (closed) return invalid()
          vm.serial_send_bytes(1, Buffer.from(bytes))
        }
      }
    }
  })
}
