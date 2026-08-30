;(() => {
  const { ascii } = globalThis.__holoV86ProbeSupport
  const {
    KERNEL_CAPABILITIES,
    capabilityRequest,
    capabilityResponse,
    completion,
    createHostBridge,
    environmentConfigurationPayload,
    errorCode,
    execRequest,
    execResponse,
    frame,
    join,
    signalPayload,
    spawnPayload,
    view
  } = globalThis.__holoV86DriverSupport

  globalThis.__holoStartV86ProcessBackend = (V86, configurationJson) => {
    const configuration = JSON.parse(configurationJson)
    const events = []
    const pending = new Map()
    const processes = new Map()
    let buffer = new Uint8Array()
    let nextRequestId = 1
    let failed = false
    let ready = false
    let serialBytes = 0
    let vm

    const emit = value => events.push(JSON.stringify(value))
    const host = createHostBridge()
    const dispatch = host.dispatch
    globalThis.__holoTakeV86BackendEvent = () => events.shift() ?? ''
    globalThis.__holoTakeV86BackendHostRequest = host.take
    globalThis.__holoResolveV86BackendHostRequest = host.resolve

    const processSource = processId => {
      const source = processes.get(processId)
      if (source == null) throw new Error('v86 process attribution unavailable')
      return source
    }
    const common = (source, processId) => ({
      environmentId: configuration.environmentId,
      executableId: source.executableId,
      generation: configuration.generation,
      linuxPid: source.linuxPid,
      policy: configuration.policy,
      processId,
      processResourceId: source.resourceId,
      scope: configuration.scope
    })
    const fuse = globalThis.__holoCreateV86FuseBridge((input, attribution) => {
      const source = attribution.source ?? processSource(attribution.processId)
      return dispatch('linuxFilesystem', { ...input, ...common(source, attribution.processId) })
    })
    const network = globalThis.__holoCreateV86NetworkBridge({ common, dispatch, processes })

    const send = (operation, requestId, processId, payload) => {
      vm.serial_send_bytes(1, frame(operation, requestId, processId, payload))
    }
    globalThis.__holoV86BackendCommand = commandJson => {
      const command = JSON.parse(commandJson)
      if (failed) return false
      if (command.operation === 'spawn') {
        if (!ready) return false
        configuration.processes[command.resourceId] = { executableId: command.executableId }
        const requestId = nextRequestId++
        pending.set(requestId, { kind: 'spawn', resourceId: command.resourceId })
        send(8, requestId, 0, spawnPayload(command))
        return true
      }
      const processId = command.processId
      if (!processes.has(processId)) return false
      const requestId = nextRequestId++
      pending.set(requestId, { callbackId: command.callbackId ?? null, kind: command.operation, processId })
      if (command.operation === 'stdin') send(11, requestId, processId, Uint8Array.from(command.bytes))
      else if (command.operation === 'end') send(12, requestId, processId)
      else if (command.operation === 'signal') send(7, requestId, processId, signalPayload(command.signal))
      else {
        pending.delete(requestId)
        return false
      }
      return true
    }
    globalThis.Headers = network.Headers
    globalThis.URL = network.URL
    globalThis.fetch = network.fetch

    const receiveFrameByte = byte => {
      serialBytes += 1
      if (configuration.diagnostics === true && serialBytes === 1) {
        emit({ event: 'backend-diagnostic', line: 'control channel received its first byte' })
      }
      buffer = join([buffer, Uint8Array.of(byte)])
      while (buffer.length >= 4) {
        const bodyLength = view(buffer).getUint32(0)
        if (buffer.length < bodyLength + 4) return
        const item = buffer.slice(0, bodyLength + 4)
        buffer = buffer.slice(bodyLength + 4)
        if (ascii(item.slice(4, 8)) !== 'HOLO' || item[8] !== 1) throw new Error('Invalid v86 frame')
        const operation = item[9]
        const requestId = view(item).getUint32(12)
        const processId = view(item).getUint32(16)
        const sequence = view(item).getUint32(20)
        const payload = item.slice(24)
        const request = pending.get(requestId)
        if (configuration.diagnostics === true && [1, 2, 3, 4, 5, 9, 10, 13, 14, 16, 19].includes(operation)) {
          const code = operation === 3 ? errorCode(payload) : null
          const fuseOpcode = operation === 14 && payload.length >= 8 ? view(payload).getUint32(4, true) : null
          emit({
            event: 'backend-diagnostic',
            line: `control channel received operation ${operation} for request ${requestId}${
              code == null ? '' : ` (${code})`
            }${fuseOpcode == null ? '' : ` fuseOpcode ${fuseOpcode}`} process ${processId} bytes ${payload.length}`
          })
        }
        if (operation === 5) {
          if (configuration.diagnostics === true) {
            emit({ event: 'backend-diagnostic', line: 'control channel received READY' })
          }
          const capabilities = payload.length >= 4 ? view(payload).getUint32(0) : 0
          const missing = configuration.requiredKernelCapabilities.filter(capability =>
            (capabilities & KERNEL_CAPABILITIES[capability]) === 0
          )
          if (missing.length !== 0) {
            failed = true
            emit({ code: 'provider.unavailable', event: 'backend-error' })
          } else {
            const configureRequestId = nextRequestId++
            pending.set(configureRequestId, { capabilities, kind: 'configure' })
            const configurationPayload = environmentConfigurationPayload({
              execGateTimeoutMs: configuration.execGateTimeoutMs,
              hosts: configuration.hosts
            })
            setTimeout(() => {
              send(18, configureRequestId, 0, configurationPayload)
              if (configuration.diagnostics === true) {
                emit({
                  event: 'backend-diagnostic',
                  line: `control channel sent CONFIGURE request ${configureRequestId}`
                })
              }
            }, 0)
          }
        } else if (operation === 9 && request?.kind === 'spawn') {
          pending.delete(requestId)
          const linuxPid = payload.length >= 4 ? view(payload).getInt32(0) : processId
          processes.set(
            processId,
            Object.freeze({
              executableId: configuration.processes[request.resourceId].executableId,
              linuxPid,
              resourceId: request.resourceId
            })
          )
          emit({ event: 'spawn', linuxPid, processId, resourceId: request.resourceId })
        } else if (operation === 1 && request?.kind === 'configure') {
          pending.delete(requestId)
          ready = true
          emit({ capabilities: request.capabilities, event: 'ready' })
        } else if (operation === 1 && request != null) {
          pending.delete(requestId)
          emit({ callbackId: request.callbackId, event: 'ack', operation: request.kind, processId })
        } else if (operation === 3) {
          if (request != null) pending.delete(requestId)
          emit({
            callbackId: request?.callbackId ?? null,
            code: errorCode(payload),
            event: 'error',
            operation: request?.kind ?? 'process',
            processId,
            resourceId: request?.resourceId ?? processes.get(processId)?.resourceId ?? null
          })
        } else if (operation === 10 || operation === 13) {
          emit({ bytes: Array.from(payload), event: operation === 10 ? 'stderr' : 'stdout', processId, sequence })
        } else if (operation === 14) {
          setTimeout(async () => {
            try {
              const terminal = await fuse.handle(payload, { processId, source: processes.get(processId) ?? null })
              if (configuration.diagnostics === true) {
                emit({
                  event: 'backend-diagnostic',
                  line: `filesystem request ${requestId} responded ${view(terminal).getInt32(4, true)}`
                })
              }
              send(15, requestId, processId, terminal)
            } catch (error) {
              send(15, requestId, processId, fuse.failure(payload, error?.errno ?? 5))
              if (configuration.diagnostics === true) {
                emit({
                  event: 'backend-diagnostic',
                  line: `filesystem request ${requestId} failed code ${error?.code ?? 'filesystem'} errno ${
                    error?.errno ?? 5
                  }`
                })
              }
            }
          }, 0)
        } else if (operation === 16) {
          setTimeout(async () => {
            let allowed = false
            try {
              const source = processSource(processId)
              const input = execRequest(payload)
              const executable = configuration.executables.find(candidate =>
                candidate.path === input.path && candidate.shell !== true
              )
              if (executable != null) {
                const result = await dispatch('linuxProcessExecution', {
                  ...common(source, processId),
                  ...input,
                  executableId: executable.executableId,
                  rootLinuxPid: source.linuxPid
                })
                allowed = result?.authorized === true
              }
            } catch {}
            send(17, requestId, processId, execResponse(allowed))
          }, 0)
        } else if (operation === 19) {
          setTimeout(async () => {
            try {
              const source = processSource(processId)
              const input = capabilityRequest(payload)
              const allowed = configuration.capabilityDomains.includes(input.command[0])
              if (!allowed) {
                send(20, requestId, processId, capabilityResponse({ error: 'bridge.unavailable', ok: false }))
                return
              }
              const value = await dispatch('linuxCapability', {
                ...common(source, processId),
                command: input.command
              })
              send(20, requestId, processId, capabilityResponse({ ok: true, value }))
            } catch (error) {
              const code = typeof error?.code === 'string' && /^[a-z][a-z\d_.-]{0,63}$/u.test(error.code)
                ? error.code
                : 'bridge.failed'
              send(20, requestId, processId, capabilityResponse({ error: code, ok: false }))
            }
          }, 0)
        } else if (operation === 4 || operation === 2) {
          const terminal = completion(payload)
          const source = processes.get(processId)
          emit({ ...terminal, event: operation === 4 ? 'exit' : 'close', processId })
          if (operation === 2) {
            processes.delete(processId)
            if (source != null) delete configuration.processes[source.resourceId]
          }
        }
      }
    }
    const receive = byte => {
      if (failed) return
      try {
        receiveFrameByte(byte)
      } catch (error) {
        failed = true
        emit({
          code: 'provider.protocol',
          event: 'backend-error',
          ...(configuration.diagnostics === true ? { message: String(error?.message ?? error) } : {})
        })
      }
    }

    configuration.processes = Object.create(null)
    vm = new V86({
      autostart: false,
      bios: { buffer: globalThis.__holoV86Bios },
      bzimage: { buffer: globalThis.__holoV86Kernel },
      cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0 audit=0 rdinit=/sbin/holo-uvd',
      disable_keyboard: true,
      disable_jit: true,
      disable_mouse: true,
      disable_speaker: true,
      filesystem: {},
      initrd: { buffer: globalThis.__holoV86Initrd },
      memory_size: configuration.memoryBytes,
      ...(configuration.network ? { net_device: { relay_url: 'fetch', type: 'virtio' } } : {}),
      screen: { container: null },
      uart1: true,
      wasm_fn: imports =>
        WebAssembly.instantiate(globalThis.__holoV86Wasm, imports)
          .then(result => result.instance.exports)
    })
    vm.add_listener('serial1-output-byte', receive)
    if (configuration.diagnostics === true) {
      let diagnosticLine = ''
      vm.add_listener('serial0-output-byte', byte => {
        const value = String.fromCharCode(byte)
        if (value === '\n') {
          emit({ event: 'backend-diagnostic', line: diagnosticLine.slice(0, 4096) })
          diagnosticLine = ''
        } else if (diagnosticLine.length < 4096 && value !== '\r') diagnosticLine += value
      })
    }
    if (configuration.network) {
      const sockets = globalThis.__holoCreateV86SocketBridge({ common, configuration, dispatch, emit, processes, vm })
      globalThis.__holoV86BackendNetworkEvent = sockets.receive
    } else globalThis.__holoV86BackendNetworkEvent = () => false
    globalThis.__holoV86BackendVm = vm
    vm.add_listener('emulator-loaded', () => {
      if (configuration.diagnostics === true) {
        emit({ event: 'backend-diagnostic', line: 'v86 emulator loaded; starting virtual CPU' })
      }
      Promise.resolve(vm.run()).catch(error => {
        failed = true
        emit({
          code: 'provider.unavailable',
          event: 'backend-error',
          ...(configuration.diagnostics === true ? { message: String(error?.message ?? error) } : {})
        })
      })
    })
  }
})()
