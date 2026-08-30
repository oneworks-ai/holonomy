;(() => {
  const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])
  const router = [192, 168, 86, 1]
  const checksum = bytes => {
    let sum = 0
    for (let index = 0; index < bytes.byteLength; index += 2) {
      sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0)
      while (sum > 0xFFFF) sum = (sum & 0xFFFF) + (sum >>> 16)
    }
    return (~sum) & 0xFFFF
  }
  const decodeDatagram = value => {
    if (!(value instanceof Uint8Array) || value.byteLength < 42) return undefined
    const bytes = Uint8Array.from(value)
    const target = new DataView(bytes.buffer)
    if (target.getUint16(12) !== 0x0800 || bytes[14] !== 0x45 || bytes[23] !== 17) return undefined
    const totalLength = target.getUint16(16)
    const fragment = target.getUint16(20)
    if ((fragment & 0x3FFF) !== 0 || totalLength < 28 || bytes.byteLength < 14 + totalLength) return undefined
    const udpLength = target.getUint16(38)
    if (udpLength < 8 || totalLength !== 20 + udpLength) return undefined
    const destinationAddress = [...bytes.slice(30, 34)]
    const destinationPort = target.getUint16(36)
    const sourcePort = target.getUint16(34)
    if (sourcePort === 0 || destinationPort === 0) return undefined
    return Object.freeze({
      destinationAddress,
      destinationMac: [...bytes.slice(0, 6)],
      destinationPort,
      internal: equal(destinationAddress, router) && [8, 53, 123].includes(destinationPort) ||
        equal(destinationAddress, [255, 255, 255, 255]) && destinationPort === 67,
      payload: bytes.slice(42, 34 + udpLength),
      sourceAddress: [...bytes.slice(26, 30)],
      sourceMac: [...bytes.slice(6, 12)],
      sourcePort
    })
  }
  const encodeDatagram = (request, value) => {
    if (!(value instanceof Uint8Array) || value.byteLength > 1472) throw new TypeError('Invalid UDP response')
    const output = new Uint8Array(42 + value.byteLength)
    const target = new DataView(output.buffer)
    output.set(request.sourceMac, 0)
    output.set(request.destinationMac, 6)
    target.setUint16(12, 0x0800)
    output[14] = 0x45
    target.setUint16(16, 28 + value.byteLength)
    target.setUint16(20, 0x4000)
    output[22] = 64
    output[23] = 17
    output.set(request.destinationAddress, 26)
    output.set(request.sourceAddress, 30)
    target.setUint16(24, checksum(output.subarray(14, 34)))
    target.setUint16(34, request.destinationPort)
    target.setUint16(36, request.sourcePort)
    target.setUint16(38, 8 + value.byteLength)
    output.set(value, 42)
    return output
  }

  globalThis.__holoCreateV86SocketBridge = ({ common, configuration, dispatch, emit, processes, vm }) => {
    const tcp = new Map()
    const udp = new Map()
    const hostLookup = new Map(configuration.hosts.map(item => [item.address, item.hostname]))
    const synthetic = value => /^192\.168\.(?:87|88)\./u.test(value)
    const source = () => {
      if (processes.size !== 1) throw new Error('v86 network process attribution unavailable')
      return processes.entries().next().value
    }
    const invoke = (channel, input) => dispatch(channel, input).catch(() => undefined)
    const install = () => {
      const adapter = vm.network_adapter
      if (adapter == null || typeof adapter.send !== 'function') return false
      adapter.on_tcp_connection = (connection, packet) => {
        if (connection.sport === 80) return
        const [processId, processSource] = source()
        const address = packet.ipv4.dest.join('.')
        const hostname = hostLookup.get(address) ?? address
        if (synthetic(address) && !hostLookup.has(address)) return
        if (configuration.diagnostics === true) {
          emit({ event: 'backend-diagnostic', line: `network tcp syn ${hostname}:${connection.sport}` })
        }
        const pending = []
        let handleId
        connection.on('data', bytes => {
          if (handleId == null) pending.push([...bytes])
          else void invoke('linuxNetworkControl', { bytes: [...bytes], handleId, operation: 'tcpWrite' })
        })
        connection.on('shutdown', () => {
          if (handleId != null) void invoke('linuxNetworkControl', { handleId, operation: 'tcpEnd' })
        })
        connection.on('close', () => {
          if (handleId != null) {
            tcp.delete(handleId)
            void invoke('linuxNetworkControl', { handleId, operation: 'close' })
          }
        })
        connection.accept(packet)
        dispatch('linuxProcessNetwork', {
          ...common(processSource, processId),
          hostname,
          operation: 'open',
          port: connection.sport,
          transport: 'tcp'
        }).then(value => {
          if (!Number.isSafeInteger(value?.handleId)) throw new Error('Invalid TCP handle')
          handleId = value.handleId
          tcp.set(handleId, connection)
          for (const bytes of pending) {
            void invoke('linuxNetworkControl', { bytes, handleId, operation: 'tcpWrite' })
          }
        }).catch(error => {
          if (configuration.diagnostics === true) {
            const code = typeof error?.code === 'string' ? error.code : 'unknown'
            emit({
              event: 'backend-diagnostic',
              line: `network tcp open failed ${hostname}:${connection.sport} code=${code}`
            })
          }
          connection.close()
        })
      }
      const originalSend = adapter.send.bind(adapter)
      adapter.send = bytes => {
        const packet = decodeDatagram(bytes)
        if (packet == null || packet.internal) return originalSend(bytes)
        const address = packet.destinationAddress.join('.')
        const hostname = hostLookup.get(address) ?? address
        if (synthetic(address) && !hostLookup.has(address)) return
        const key = `${packet.sourcePort}:${hostname}:${packet.destinationPort}`
        const existing = udp.get(key)
        if (existing != null) {
          existing.packet = packet
          void invoke('linuxNetworkControl', {
            bytes: [...packet.payload],
            handleId: existing.handleId,
            operation: 'udpSend'
          })
          return
        }
        const [processId, processSource] = source()
        dispatch('linuxProcessNetwork', {
          ...common(processSource, processId),
          hostname,
          operation: 'open',
          port: packet.destinationPort,
          transport: 'udp'
        }).then(value => {
          if (!Number.isSafeInteger(value?.handleId)) throw new Error('Invalid UDP handle')
          const flow = { handleId: value.handleId, key, packet }
          udp.set(key, flow)
          udp.set(value.handleId, flow)
          return dispatch('linuxNetworkControl', {
            bytes: [...packet.payload],
            handleId: value.handleId,
            operation: 'udpSend'
          })
        }).catch(() => {
          if (configuration.diagnostics === true) {
            emit({ event: 'backend-diagnostic', line: `network udp open failed ${hostname}:${packet.destinationPort}` })
          }
        })
      }
      return true
    }
    const adapterReceive = (flow, bytes) => {
      vm.network_adapter.receive(encodeDatagram(flow.packet, Uint8Array.from(bytes)))
    }
    const receive = sourceJson => {
      const event = JSON.parse(sourceJson)
      if (event.transport === 'tcp') {
        const connection = tcp.get(event.handleId)
        if (connection == null) return false
        if (event.event === 'data') connection.write(Uint8Array.from(event.bytes))
        else if (event.event === 'end' || event.event === 'close' || event.event === 'error') {
          tcp.delete(event.handleId)
          connection.close()
        }
        return true
      }
      const flow = udp.get(event.handleId)
      if (flow == null) return false
      if (event.event === 'data') adapterReceive(flow, event.bytes)
      else if (event.event === 'close' || event.event === 'error') {
        udp.delete(flow.handleId)
        udp.delete(flow.key)
      }
      return true
    }
    if (!install()) vm.add_listener('emulator-ready', install)
    return Object.freeze({ receive })
  }
})()
