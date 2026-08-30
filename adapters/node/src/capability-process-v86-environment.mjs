import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import process from 'node:process'

import { createHoloUvSupervisorEnvironmentFactoryV1, encodeHoloUvEnvironmentConfigurationV1 } from '@holonomyjs/holouv'
import { decodeV86UdpDatagramV1, encodeV86UdpResponseV1 } from './capability-process-v86-udp.mjs'

const invalid = () => {
  throw new TypeError('Invalid v86 Process environment')
}
const MAX_PENDING_NETWORK_BYTES = 64 * 1024
const UDP_IDLE_TIMEOUT_MS = 30_000

const ipv4 = value => {
  const parts = value.split('.')
  return parts.length === 4 && parts.every(part => /^(?:0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)
}

const environmentHosts = policy => {
  if (policy?.network?.access !== 'restricted') return Object.freeze([])
  const hostnames = [
    ...new Set(
      policy.network.endpoints.map(endpoint => endpoint.hostname).filter(value => !ipv4(value) && value !== 'localhost')
    )
  ].sort()
  return Object.freeze(hostnames.map((hostname, index) =>
    Object.freeze({
      address: `192.168.${87 + Math.floor(index / 254)}.${index % 254 + 1}`,
      hostname
    })
  ))
}

const syntheticHostAddress = value => {
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts[0] === 192 && parts[1] === 168 &&
    (parts[2] === 87 || parts[2] === 88)
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
        'tsc=reliable mitigations=off random.trust_cpu=on earlyprintk=serial,ttyS0,115200 console=ttyS0 audit=0 rdinit=/sbin/holo-uvd',
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
    options.handleExecutionRequest != null && typeof options.handleExecutionRequest !== 'function' ||
    options.handleCapabilityRequest != null && typeof options.handleCapabilityRequest !== 'function' ||
    options.handleNetworkConnection != null && typeof options.handleNetworkConnection !== 'function' ||
    options.handleNetworkDatagram != null && typeof options.handleNetworkDatagram !== 'function' ||
    options.handleNetworkRequest != null && typeof options.handleNetworkRequest !== 'function' ||
    options.onKernelCapabilities != null && typeof options.onKernelCapabilities !== 'function'
  ) return invalid()
  return createHoloUvSupervisorEnvironmentFactoryV1({
    createConfiguration(request) {
      return encodeHoloUvEnvironmentConfigurationV1({
        execGateTimeoutMs: request.configuration.supervisor.execGateTimeoutMs,
        hosts: environmentHosts(request.policy),
        version: 1
      })
    },
    ...(options.handleExecutionRequest == null
      ? {}
      : { handleExecutionRequest: options.handleExecutionRequest }),
    ...(options.handleCapabilityRequest == null
      ? {}
      : { handleCapabilityRequest: options.handleCapabilityRequest }),
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
      const hostLookup = new Map(environmentHosts(request.policy).map(host => [host.address, host.hostname]))
      const V86 = options.V86 ?? await options.loadV86()
      if (typeof V86 !== 'function') return invalid()
      const prepared = await v86Options(
        request.configuration,
        V86,
        options.loadArtifact,
        options.handleNetworkRequest != null || options.handleNetworkConnection != null ||
          options.handleNetworkDatagram != null
      )
      const vm = new prepared.V86(prepared.options)
      if (process.env.HOLO_V86_TRACE === '1') {
        vm.add_listener('serial0-output-byte', byte => process.stderr.write(String.fromCharCode(byte)))
      }
      const networkSockets = new Set()
      const udpFlows = new Map()
      let pendingNetworkSockets = 0
      try {
        if (
          options.handleNetworkRequest != null || options.handleNetworkConnection != null ||
          options.handleNetworkDatagram != null
        ) {
          const installNetworkBridge = () => {
            if (typeof vm.network_adapter?.fetch !== 'function') return false
            if (options.handleNetworkRequest != null) {
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
            }
            if (options.handleNetworkConnection != null) {
              vm.network_adapter.on_tcp_connection = (connection, packet) => {
                if (process.env.HOLO_V86_TRACE === '1') {
                  process.stderr.write(
                    `[v86:tcp-syn] ${packet.ipv4.dest.join('.')}:${connection.sport}\n`
                  )
                }
                if (connection.sport === 80) return
                const destination = packet.ipv4.dest.join('.')
                const hostname = hostLookup.get(destination) ?? destination
                if (syntheticHostAddress(destination) && !hostLookup.has(destination)) return
                const maximum = request.policy?.network?.access === 'restricted'
                  ? request.policy.network.maxSockets
                  : 0
                if (networkSockets.size + pendingNetworkSockets >= maximum) return
                let source
                try {
                  source = request.resolveProcessSource()
                } catch {
                  return
                }
                const pending = []
                let pendingBytes = 0
                let pendingCounted = false
                let closed = false
                let socket
                const settlePending = () => {
                  if (!pendingCounted) return
                  pendingCounted = false
                  pendingNetworkSockets -= 1
                }
                connection.on('data', bytes => {
                  if (socket == null) {
                    pendingBytes += bytes.byteLength
                    if (pendingBytes > MAX_PENDING_NETWORK_BYTES) {
                      connection.close()
                      return
                    }
                    pending.push(Uint8Array.from(bytes))
                  } else socket.write(bytes)
                })
                connection.on('shutdown', () => socket?.end())
                connection.on('close', () => {
                  closed = true
                  socket?.destroy()
                })
                connection.accept(packet)
                pendingNetworkSockets += 1
                pendingCounted = true
                Promise.resolve(options.handleNetworkConnection(Object.freeze({
                  environmentId: request.environmentId,
                  executableId: source.executableId,
                  generation: request.generation,
                  hostname,
                  linuxPid: source.linuxPid,
                  policy: request.policy,
                  port: connection.sport,
                  processId: source.processId,
                  processResourceId: source.processResourceId,
                  scope: request.scope,
                  signal: request.signal
                }))).then(value => {
                  settlePending()
                  if (
                    value == null || typeof value.on !== 'function' ||
                    typeof value.write !== 'function' || typeof value.destroy !== 'function'
                  ) return invalid()
                  socket = value
                  networkSockets.add(socket)
                  socket.on('data', bytes => connection.write(bytes))
                  socket.once('end', () => connection.close())
                  socket.once('error', () => connection.close())
                  socket.once('close', () => networkSockets.delete(socket))
                  if (closed) socket.destroy()
                  else for (const bytes of pending) socket.write(bytes)
                }).catch(() => {
                  settlePending()
                  connection.close()
                })
              }
            }
            if (options.handleNetworkDatagram != null) {
              const originalSend = vm.network_adapter.send.bind(vm.network_adapter)
              const closeFlow = flow => {
                clearTimeout(flow.timer)
                udpFlows.delete(flow.key)
                if (flow.socket != null) {
                  try {
                    flow.socket.close()
                  } catch {}
                }
              }
              const scheduleClose = flow => {
                clearTimeout(flow.timer)
                flow.timer = setTimeout(() => closeFlow(flow), UDP_IDLE_TIMEOUT_MS)
              }
              vm.network_adapter.send = bytes => {
                const packet = decodeV86UdpDatagramV1(bytes)
                if (packet == null || packet.internal) return originalSend(bytes)
                const destination = packet.destinationAddress.join('.')
                const hostname = hostLookup.get(destination) ?? destination
                if (process.env.HOLO_V86_TRACE === '1') {
                  process.stderr.write(
                    `[v86:udp-send] ${hostname}:${packet.destinationPort} bytes=${packet.payload.byteLength}\n`
                  )
                }
                if (syntheticHostAddress(destination) && !hostLookup.has(destination)) return
                const key = `${packet.sourcePort}:${hostname}:${packet.destinationPort}`
                const existing = udpFlows.get(key)
                if (existing != null) {
                  existing.packet = packet
                  scheduleClose(existing)
                  if (existing.socket == null) {
                    existing.pendingBytes += packet.payload.byteLength
                    if (existing.pendingBytes > MAX_PENDING_NETWORK_BYTES) closeFlow(existing)
                    else existing.pending.push(packet.payload)
                  } else existing.socket.send(packet.payload)
                  return
                }
                const maximum = request.policy?.network?.access === 'restricted'
                  ? request.policy.network.maxSockets
                  : 0
                if (networkSockets.size + pendingNetworkSockets + udpFlows.size >= maximum) return
                let source
                try {
                  source = request.resolveProcessSource()
                } catch {
                  return
                }
                const flow = {
                  key,
                  packet,
                  pending: [packet.payload],
                  pendingBytes: packet.payload.byteLength,
                  socket: undefined,
                  timer: undefined
                }
                udpFlows.set(key, flow)
                scheduleClose(flow)
                Promise.resolve(options.handleNetworkDatagram(Object.freeze({
                  environmentId: request.environmentId,
                  executableId: source.executableId,
                  generation: request.generation,
                  hostname,
                  linuxPid: source.linuxPid,
                  policy: request.policy,
                  port: packet.destinationPort,
                  processId: source.processId,
                  processResourceId: source.processResourceId,
                  scope: request.scope,
                  signal: request.signal
                }))).then(socket => {
                  if (
                    socket == null || typeof socket.on !== 'function' ||
                    typeof socket.send !== 'function' || typeof socket.close !== 'function'
                  ) return invalid()
                  if (udpFlows.get(key) !== flow) {
                    socket.close()
                    return
                  }
                  flow.socket = socket
                  socket.on('message', value => {
                    if (process.env.HOLO_V86_TRACE === '1') {
                      process.stderr.write(
                        `[v86:udp-receive] ${hostname}:${packet.destinationPort} bytes=${value.length}\n`
                      )
                    }
                    scheduleClose(flow)
                    try {
                      vm.network_adapter.receive(encodeV86UdpResponseV1(flow.packet, Uint8Array.from(value)))
                    } catch {}
                  })
                  socket.once('error', () => closeFlow(flow))
                  socket.once('close', () => {
                    clearTimeout(flow.timer)
                    udpFlows.delete(key)
                  })
                  for (const value of flow.pending) socket.send(value)
                  flow.pending = []
                  flow.pendingBytes = 0
                }).catch(error => {
                  if (process.env.HOLO_V86_TRACE === '1') {
                    process.stderr.write(`[v86:udp-error] ${String(error?.code ?? error)}\n`)
                  }
                  closeFlow(flow)
                })
              }
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
          for (const socket of networkSockets) socket.destroy()
          networkSockets.clear()
          for (const flow of udpFlows.values()) {
            clearTimeout(flow.timer)
            try {
              flow.socket?.close()
            } catch {}
          }
          udpFlows.clear()
          vm.remove_listener('serial1-output-byte', output)
          vm.remove_listener('download-error', downloadError)
          vm.remove_listener('emulator-stopped', stopped)
          await vm.destroy()
        },
        ...(options.handleNetworkRequest == null && options.handleNetworkConnection == null &&
            options.handleNetworkDatagram == null
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
