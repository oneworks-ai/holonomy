;(() => {
  const { bytes } = globalThis.__holoV86ProbeSupport
  const view = value => new DataView(value.buffer, value.byteOffset, value.byteLength)
  const u16 = value => Uint8Array.of(value >>> 8, value)
  const u32 = value => Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value)
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
    const encoded = new TextEncoder().encode(String(value))
    return join([u32(encoded.length), encoded])
  }
  const reader = value => {
    const input = Uint8Array.from(value)
    const target = view(input)
    let offset = 0
    const u8 = () => {
      if (offset + 1 > input.length) throw new TypeError('Invalid v86 payload')
      return input[offset++]
    }
    const u16Value = () => {
      if (offset + 2 > input.length) throw new TypeError('Invalid v86 payload')
      const output = target.getUint16(offset)
      offset += 2
      return output
    }
    const u32Value = () => {
      if (offset + 4 > input.length) throw new TypeError('Invalid v86 payload')
      const output = target.getUint32(offset)
      offset += 4
      return output
    }
    const text = () => {
      const length = u32Value()
      if (length === 0 || length > 4096 || offset + length > input.length) {
        throw new TypeError('Invalid v86 payload')
      }
      const source = input.slice(offset, offset + length)
      offset += length
      return new TextDecoder('utf-8', { fatal: true }).decode(source)
    }
    return Object.freeze({
      done: () => {
        if (offset !== input.length) throw new TypeError('Invalid v86 payload')
      },
      text,
      u8,
      u16: u16Value,
      u32: u32Value
    })
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
  const spawnPayload = input => {
    const env = Object.entries(input.env ?? {}).sort(([left], [right]) => left.localeCompare(right))
    return join([
      Uint8Array.of(
        1,
        input.stdio.reduce((mask, mode, index) => mode === 'pipe' ? mask | (1 << index) : mask, 0),
        0,
        0
      ),
      string(input.executable),
      string(input.cwd),
      string(input.executableId),
      string(input.resourceId),
      u16(input.args.length),
      u16(env.length),
      ...input.args.map(string),
      ...env.flatMap(([name, value]) => [string(name), string(value)])
    ])
  }
  const completion = payload => {
    const code = view(payload).getInt32(0)
    const length = view(payload).getUint32(4)
    const signal = new TextDecoder().decode(payload.slice(8, 8 + length))
    return { code: code === -1 ? null : code, signal: signal === '' ? null : signal }
  }
  const errorCode = payload => {
    const length = view(payload).getUint32(0)
    return new TextDecoder().decode(payload.slice(4, 4 + length))
  }
  const environmentConfigurationPayload = input => {
    const hosts = [...(input.hosts ?? [])].sort((left, right) => left.hostname.localeCompare(right.hostname))
    return join([
      Uint8Array.of(1, 0),
      u16(hosts.length),
      u32(input.execGateTimeoutMs),
      ...hosts.flatMap(host => [string(host.address), string(host.hostname)])
    ])
  }
  const execRequest = payload => {
    const input = reader(payload)
    const linuxPid = input.u32()
    const parentLinuxPid = input.u32()
    const path = input.text()
    const cwd = input.text()
    const count = input.u16()
    if (linuxPid === 0 || parentLinuxPid === 0 || count === 0 || count > 256) {
      throw new TypeError('Invalid v86 exec request')
    }
    const argv = Array.from({ length: count }, input.text)
    input.done()
    if (!path.startsWith('/') || !cwd.startsWith('/')) throw new TypeError('Invalid v86 exec request')
    return Object.freeze({ argv, cwd, linuxPid, parentLinuxPid, path })
  }
  const capabilityRequest = payload => {
    const input = reader(payload)
    const version = input.u8()
    const count = input.u8()
    if (version !== 1 || count < 2 || count > 8 || input.u16() !== 0) {
      throw new TypeError('Invalid v86 capability request')
    }
    const command = Array.from({ length: count }, input.text)
    input.done()
    if (command.some(value => !/^[\w.:/-]{1,4096}$/u.test(value))) {
      throw new TypeError('Invalid v86 capability request')
    }
    return Object.freeze({ command, version: 1 })
  }
  const capabilityResponse = value => {
    const ok = value?.ok === true
    const text = ok ? JSON.stringify(value.value) : String(value?.error ?? 'bridge.failed')
    if (!ok && !/^[a-z][a-z\d_.-]{0,63}$/u.test(text)) throw new TypeError('Invalid v86 capability response')
    return join([Uint8Array.of(1, ok ? 1 : 0, 0, 0), string(text)])
  }
  const createHostBridge = () => {
    const pending = new Map()
    const requests = []
    let nextRequestId = 1
    return Object.freeze({
      dispatch: (channel, input) =>
        new Promise((resolve, reject) => {
          const id = nextRequestId++
          pending.set(id, { reject, resolve })
          requests.push(JSON.stringify({
            channel,
            id,
            request: {
              ...input,
              ...(input.bytes instanceof Uint8Array ? { bytes: Array.from(input.bytes) } : {})
            }
          }))
        }),
      resolve: (id, terminalJson) => {
        const item = pending.get(id)
        if (item == null) return false
        pending.delete(id)
        const terminal = JSON.parse(terminalJson)
        if (terminal.ok !== true) {
          const error = new Error(terminal.error?.message ?? 'v86 Host invocation failed')
          error.code = terminal.error?.code
          error.errno = terminal.error?.errno
          item.reject(error)
        } else if (terminal.result?.kind === 'bytes') {
          item.resolve(Uint8Array.from(terminal.result.bytes))
        } else {
          item.resolve(terminal.result?.value)
        }
        return true
      },
      take: () => requests.shift() ?? ''
    })
  }

  globalThis.__holoV86DriverSupport = Object.freeze({
    KERNEL_CAPABILITIES: Object.freeze({
      cgroups: 1 << 4,
      fanotify: 1 << 5,
      fuse: 1 << 1,
      networkNamespaces: 1 << 3,
      process: 1,
      seccompUserNotification: 1 << 6,
      tun: 1 << 2
    }),
    capabilityRequest,
    capabilityResponse,
    completion,
    createHostBridge,
    environmentConfigurationPayload,
    errorCode,
    execRequest,
    execResponse: allowed => Uint8Array.of(allowed ? 1 : 0),
    frame,
    join,
    signalPayload: signal => string(signal),
    spawnPayload,
    view
  })
})()
