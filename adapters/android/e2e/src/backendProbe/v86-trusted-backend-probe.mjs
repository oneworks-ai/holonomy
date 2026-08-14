;(() => {
  const { ascii, bytes } = globalThis.__holoV86ProbeSupport
  const u16 = value => Uint8Array.of(value >>> 8, value)
  const u32 = value => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)
  const readU32 = (value, offset) => new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset)
  const join = parts => {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let offset = 0
    for (const part of parts) {
      output.set(part, offset)
      offset += part.length
    }
    return output
  }
  const string = value => {
    const encoded = bytes(value)
    return join([u32(encoded.length), encoded])
  }
  const frame = (operation, requestId, processId, payload = new Uint8Array()) =>
    join([
      u32(20 + payload.length),
      bytes('HOLO'),
      Uint8Array.of(1, operation, 0, 0),
      u32(requestId),
      u32(processId),
      u32(0),
      payload
    ])
  const spawnPayload = ({ args, executable, executableId, resourceId }) =>
    join([
      Uint8Array.of(1, 7, 0, 0),
      string(executable),
      string('/'),
      string(executableId),
      string(resourceId),
      u16(args.length),
      u16(1),
      ...args.map(string),
      string('LANG'),
      string('C')
    ])

  const checkedTerminal = source => {
    const terminal = JSON.parse(source)
    if (terminal?.ok !== true) {
      throw Object.assign(new Error(terminal?.error?.message ?? 'Linux filesystem invocation failed'), {
        code: terminal?.error?.code,
        errno: terminal?.error?.errno
      })
    }
    if (terminal.result?.kind === 'bytes') return Uint8Array.from(terminal.result.bytes)
    if (terminal.result?.kind === 'value') return terminal.result.value
    throw Object.assign(new Error('Invalid Linux filesystem terminal'), { errno: 5 })
  }
  const serializable = input => ({
    ...input,
    ...(input.bytes instanceof Uint8Array ? { bytes: Array.from(input.bytes) } : {})
  })
  class ProbeHeaders {
    constructor(input = []) {
      this.values = new Map()
      const entries = input instanceof ProbeHeaders
        ? input.entries()
        : Array.isArray(input)
        ? input
        : Object.entries(input)
      for (const [name, value] of entries) this.set(name, value)
    }

    delete(name) {
      this.values.delete(String(name).toLowerCase())
    }

    append(name, value) {
      const key = String(name).toLowerCase()
      const previous = this.values.get(key)
      this.values.set(key, previous == null ? String(value) : `${previous}, ${value}`)
    }

    entries() {
      return this.values.entries()
    }

    get(name) {
      return this.values.get(String(name).toLowerCase()) ?? null
    }

    set(name, value) {
      this.values.set(String(name).toLowerCase(), String(value))
    }

    [Symbol.iterator]() {
      return this.entries()
    }
  }
  class ProbeURL {
    constructor(input) {
      const match = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/u.exec(String(input))
      if (match == null) throw new TypeError('Invalid v86 probe URL')
      this.protocolValue = `${match[1]}:`
      this.hostnameValue = match[2]
      this.portValue = match[3] ?? ''
      this.pathValue = match[4] ?? '/'
    }

    get host() {
      return this.portValue === '' ? this.hostnameValue : `${this.hostnameValue}:${this.portValue}`
    }

    set host(value) {
      const match = /^([^:]+)(?::(\d+))?$/u.exec(String(value))
      if (match == null) throw new TypeError('Invalid v86 probe host')
      this.hostnameValue = match[1]
      this.portValue = match[2] ?? ''
    }

    get hostname() {
      return this.hostnameValue
    }

    set hostname(value) {
      this.hostnameValue = String(value)
    }

    get href() {
      return `${this.protocolValue}//${this.host}${this.pathValue}`
    }

    get port() {
      return this.portValue
    }

    set port(value) {
      this.portValue = String(value)
    }

    get protocol() {
      return this.protocolValue
    }

    set protocol(value) {
      this.protocolValue = String(value)
    }
  }

  globalThis.__holoStartV86TrustedBackendProbe = (V86, configurationJson) => {
    let vm
    const configuration = JSON.parse(configurationJson)
    const common = Object.freeze({
      environmentId: configuration.environmentId,
      executableId: 'android-v86-selftest',
      policy: configuration.policy,
      processId: 9,
      processResourceId: 'android-v86-selftest-process',
      scope: 'runtime'
    })
    const pending = new Map()
    const requests = []
    const hostResults = []
    let nextHostRequestId = 1
    let state
    const dispatch = (channel, input) =>
      new Promise((resolve, reject) => {
        const id = nextHostRequestId++
        state.lastHostRequest = { channel, id, operation: input.operation ?? null, path: input.path ?? null }
        pending.set(id, { channel, input, reject, resolve })
        requests.push(Object.freeze({ channel, id, request: serializable({ ...common, ...input }) }))
      })
    globalThis.__holoTakeV86TrustedBackendRequest = () => requests.length === 0 ? '' : JSON.stringify(requests.shift())
    globalThis.__holoResolveV86TrustedBackendRequest = (id, terminalJson) => {
      const item = pending.get(id)
      if (item == null) return false
      pending.delete(id)
      state.completedHostRequests += 1
      try {
        const value = checkedTerminal(terminalJson)
        hostResults.push({
          channel: item.channel,
          operation: item.input.operation,
          path: item.input.path ?? null,
          value: value == null || typeof value !== 'object'
            ? value ?? null
            : value instanceof Uint8Array
            ? `bytes:${value.byteLength}`
            : Object.keys(value).sort()
        })
        item.resolve(value)
      } catch (error) {
        error.message = `${item.input.operation}:${item.input.path ?? '<resource>'}: ${error.message}`
        item.reject(error)
      }
      return true
    }

    const fetch = async (input, init = {}) => {
      const url = String(input)
      const match = /^http:\/\/(127\.0\.0\.1):(\d+)(\/[^#]*)?$/u.exec(url)
      if (match == null) {
        throw Object.assign(new Error('Unsupported v86 network endpoint'), {
          code: 'process.network_endpoint_unsupported'
        })
      }
      const value = await dispatch('linuxProcessNetwork', {
        headers: [...new ProbeHeaders(init.headers).entries()],
        hostname: match[1],
        linuxPid: state.pid,
        method: init.method ?? 'GET',
        port: Number(match[2]),
        transport: 'tcp',
        url
      })
      const body = Uint8Array.from(value.bodyBytes)
      return Object.freeze({
        arrayBuffer: async () => body.slice().buffer,
        body: null,
        headers: new ProbeHeaders(value.headers),
        redirected: value.redirected === true,
        status: value.status,
        statusText: value.statusText,
        url: value.url
      })
    }

    state = {
      bootStartedAt: Date.now(),
      buffer: new Uint8Array(),
      completedHostRequests: 0,
      frameCounts: {},
      fuse: globalThis.__holoCreateV86FuseProbe(input => dispatch('linuxFilesystem', input)),
      fusePid: 0,
      lastHostRequest: null,
      networkPid: 0,
      networkStdout: '',
      pid: 0,
      stage: 'booting',
      stdout: ''
    }
    globalThis.__holoV86TrustedBackendDiagnostics = () =>
      JSON.stringify({
        completedHostRequests: state.completedHostRequests,
        frameCounts: state.frameCounts,
        fuseEvents: state.fuse.events.length,
        lastHostRequest: state.lastHostRequest,
        pendingHostRequests: pending.size,
        pid: state.pid,
        queuedHostRequests: requests.length,
        stage: state.stage,
        stdoutBytes: state.stdout.length
      })
    globalThis.Headers = ProbeHeaders
    globalThis.URL = ProbeURL
    globalThis.fetch = fetch
    const fail = error => {
      globalThis.__holoV86TrustedBackendFailure = String(error?.stack ?? error?.message ?? error)
    }
    const send = (operation, requestId, processId, payload) => {
      vm.serial_send_bytes(1, frame(operation, requestId, processId, payload))
    }
    const complete = async () => {
      state.stage = 'reading-output'
      const read = state.fuse.events.find(event => event.operation === 'read')
      const write = state.fuse.events.find(event => event.operation === 'write')
      const outputHandle = await dispatch('linuxFilesystem', {
        flags: 0,
        linuxPid: state.fusePid,
        operation: 'open',
        path: '/workspace/output.txt'
      })
      const output = await dispatch('linuxFilesystem', {
        handle: outputHandle,
        linuxPid: state.fusePid,
        offset: 0,
        operation: 'read',
        path: '/workspace/output.txt',
        size: 64
      })
      await dispatch('linuxFilesystem', {
        handle: outputHandle,
        linuxPid: state.fusePid,
        operation: 'release',
        path: '/workspace/output.txt'
      })
      globalThis.__holoV86TrustedBackendResult = JSON.stringify({
        backend: 'v86',
        bootDurationMs: state.bootDurationMs,
        code: state.code,
        fuseEvents: state.fuse.events.length,
        fuseOperations: state.fuse.events.map(event => `${event.operation}:${event.path}`),
        hostResults,
        linuxPid: read?.linuxPid ?? 0,
        network: {
          authorized: hostResults.some(result => result.channel === 'linuxProcessNetwork'),
          linuxPid: state.networkPid,
          stdout: state.networkStdout
        },
        output: ascii(output),
        processId: read?.processId ?? 0,
        stdout: state.stdout,
        writeLinuxPid: write?.linuxPid ?? 0,
        workloadDurationMs: Date.now() - state.workloadStartedAt
      })
      state.stage = 'complete'
    }
    const receive = byte => {
      state.buffer = join([state.buffer, Uint8Array.of(byte)])
      while (state.buffer.length >= 4) {
        const bodyLength = readU32(state.buffer, 0)
        if (state.buffer.length < bodyLength + 4) return
        const item = state.buffer.slice(0, bodyLength + 4)
        state.buffer = state.buffer.slice(bodyLength + 4)
        if (ascii(item.slice(4, 8)) !== 'HOLO' || item[8] !== 1) throw new Error('Invalid v86 frame')
        const operation = item[9]
        state.frameCounts[operation] = (state.frameCounts[operation] ?? 0) + 1
        const requestId = readU32(item, 12)
        const processId = readU32(item, 16)
        const payload = item.slice(24)
        if (operation === 5) {
          state.stage = 'spawning'
          state.bootDurationMs = Date.now() - state.bootStartedAt
          state.workloadStartedAt = Date.now()
          send(
            8,
            1,
            0,
            spawnPayload({
              args: ['fuse'],
              executable: '/holo-selftest',
              executableId: common.executableId,
              resourceId: common.processResourceId
            })
          )
        } else if (operation === 9 && requestId === 1) {
          state.pid = processId
          state.fusePid = processId
          state.stage = 'running'
        } else if (operation === 9 && requestId === 2) {
          state.pid = processId
          state.networkPid = processId
          state.stage = 'network'
        } else if (operation === 14) {
          state.stage = 'filesystem'
          setTimeout(async () => {
            try {
              const response = await state.fuse.handle(payload, { processId })
              send(15, requestId, processId, response)
            } catch (error) {
              fail(error)
            }
          }, 0)
        } else if (operation === 13 && processId === state.fusePid) state.stdout += ascii(payload)
        else if (operation === 13 && processId === state.networkPid) state.networkStdout += ascii(payload)
        else if (operation === 4 && processId === state.pid) state.code = readU32(payload, 0)
        else if (operation === 2 && processId === state.fusePid && state.networkPid === 0) {
          state.stage = 'network-spawning'
          send(
            8,
            2,
            0,
            spawnPayload({
              args: ['network', String(configuration.networkPort)],
              executable: '/holo-selftest',
              executableId: common.executableId,
              resourceId: common.processResourceId
            })
          )
        } else if (operation === 2 && processId === state.networkPid) {
          setTimeout(async () => {
            try {
              await complete()
            } catch (error) {
              fail(error)
            }
          }, 0)
        } else if (operation === 3) {
          const length = readU32(payload, 0)
          throw new Error(ascii(payload.slice(4, 4 + length)))
        }
      }
    }
    vm = new V86({
      autostart: true,
      bios: { buffer: globalThis.__holoV86Bios },
      bzimage: { buffer: globalThis.__holoV86Kernel },
      cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0 audit=0 rdinit=/holo-supervisor',
      disable_keyboard: true,
      disable_jit: true,
      disable_mouse: true,
      disable_speaker: true,
      filesystem: {},
      initrd: { buffer: globalThis.__holoV86Initrd },
      memory_size: 128 * 1024 * 1024,
      net_device: { relay_url: 'fetch', type: 'virtio' },
      screen: { container: null },
      uart1: true,
      wasm_fn: imports =>
        WebAssembly.instantiate(globalThis.__holoV86Wasm, imports)
          .then(result => result.instance.exports)
    })
    vm.add_listener('serial1-output-byte', receive)
    globalThis.__holoV86TrustedBackendVm = vm
  }
})()
