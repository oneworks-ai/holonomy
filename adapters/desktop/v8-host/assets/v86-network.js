// Private v86 isolate data plane. The pinned vendor owns Ethernet, TCP/IP,
// DHCP and its port-80 HTTP proxy; this file only queues bounded Host messages.
;(() => {
  const MAX_EVENTS = 64
  const MAX_TERMINALS = 32
  const MAX_FLOWS = 32
  const MAX_QUEUE_BYTES = 256 * 1024
  const MAX_CHUNK = 16 * 1024
  const MAX_UDP_FRAME = 2048
  const MAX_HTTP_BODY = 32 * 1024
  const MAX_HTTP_HEADERS = 64
  const MAX_HTTP_HEADER_BYTES = 16 * 1024
  const MAX_HTTP_URL_BYTES = 2048
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const events = []
  const terminals = []
  const flows = new Map()
  const udpFlows = new Map()
  let queuedBytes = 0
  let nextSequence = 0
  let nextStreamId = 0
  let adapter

  const encode = input => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    let output = ''
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index]
      const b = bytes[index + 1]
      const c = bytes[index + 2]
      output += alphabet[a >> 2] + alphabet[(a & 3) << 4 | (b ?? 0) >> 4] +
        (b === undefined ? '=' : alphabet[(b & 15) << 2 | (c ?? 0) >> 6]) +
        (c === undefined ? '=' : alphabet[c & 63])
    }
    return output
  }
  const decode = input => {
    if (typeof input !== 'string' || input.length % 4 !== 0) throw new TypeError('Invalid v86 network base64')
    const bytes = []
    for (let index = 0; index < input.length; index += 4) {
      const a = alphabet.indexOf(input[index])
      const b = alphabet.indexOf(input[index + 1])
      const c = input[index + 2] === '=' ? -1 : alphabet.indexOf(input[index + 2])
      const d = input[index + 3] === '=' ? -1 : alphabet.indexOf(input[index + 3])
      if (a < 0 || b < 0 || c < -1 || d < -1 || (c < 0 && d >= 0)) throw new TypeError('Invalid v86 network base64')
      bytes.push((a << 2 | b >> 4) & 255)
      if (c >= 0) bytes.push((b << 4 | c >> 2) & 255)
      if (d >= 0) bytes.push((c << 6 | d) & 255)
    }
    const value = Uint8Array.from(bytes)
    if (encode(value) !== input) throw new TypeError('Invalid v86 network base64')
    return value
  }
  const push = (kind, streamId, fields = {}, terminal = false) => {
    if (nextSequence >= Number.MAX_SAFE_INTEGER) return false
    const event = { sequence: ++nextSequence, kind, streamId, ...fields }
    const size = new TextEncoder().encode(JSON.stringify(event)).byteLength
    if (terminal) {
      if (terminals.length >= MAX_TERMINALS) return false
      terminals.push({ event, size })
      return true
    }
    if (events.length >= MAX_EVENTS || queuedBytes + size > MAX_QUEUE_BYTES) return false
    events.push({ event, size })
    queuedBytes += size
    return true
  }
  const allocate = (kind, value) => {
    // Every live flow owns one terminal slot until its close event is drained.
    if (flows.size + terminals.length >= MAX_FLOWS || nextStreamId >= Number.MAX_SAFE_INTEGER) return undefined
    const id = ++nextStreamId
    flows.set(id, { ...value, kind, closed: false, authorized: false, pendingBytes: 0 })
    return id
  }
  const closeFlow = (id, reason = 'closed') => {
    const flow = flows.get(id)
    if (flow == null || flow.closed) return
    flow.closed = true
    flows.delete(id)
    if (flow.timer != null) clearTimeout(flow.timer)
    if (flow.kind === 'tcp') {
      try { flow.connection.close() } catch {}
      if (!push('tcpClose', id, { reason }, true)) throw new Error('v86 close reservation lost')
    } else if (flow.kind === 'udp') {
      udpFlows.delete(flow.key)
    } else {
      flow.error = new Error('v86 HTTP relay closed')
      flow.reject?.(flow.error)
      flow.pendingRead?.reject(flow.error)
      if (!push('httpCancel', id, { reason }, true)) throw new Error('v86 close reservation lost')
    }
  }
  const pushTcpData = (id, value) => {
    const flow = flows.get(id)
    if (flow == null || flow.closed) return
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
    if (!flow.authorized && flow.pendingBytes + bytes.byteLength > 64 * 1024) return closeFlow(id, 'limit')
    for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK) {
      const chunk = bytes.subarray(offset, offset + MAX_CHUNK)
      if (!push('tcpData', id, { base64: encode(chunk) })) return closeFlow(id, 'limit')
    }
    if (!flow.authorized) flow.pendingBytes += bytes.byteLength
  }
  const externalUdp = bytes => {
    if (bytes.length < 42 || bytes.length > MAX_UDP_FRAME || bytes[12] !== 8 || bytes[13] !== 0 ||
      bytes[14] >> 4 !== 4 || bytes[23] !== 17) return undefined
    const port = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(36)
    const address = `${bytes[30]}.${bytes[31]}.${bytes[32]}.${bytes[33]}`
    if (address === '192.168.86.1' && [8, 53, 123].includes(port) ||
      address === '255.255.255.255' && port === 67) return undefined
    const sourcePort = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(34)
    return { address, port, key: `${sourcePort}:${address}:${port}` }
  }
  const touchUdp = id => {
    const flow = flows.get(id)
    if (flow?.kind !== 'udp') return
    if (flow.timer != null) clearTimeout(flow.timer)
    flow.timer = setTimeout(() => closeFlow(id, 'idle'), 30_000)
  }
  const requestHttp = (url, init) => {
    const selectedUrl = String(url)
    const method = String(init?.method ?? 'GET')
    const headers = [...(init?.headers?.entries?.() ?? [])]
    const body = init?.body == null ? new Uint8Array() :
      init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body)
    const size = headers.reduce((sum, [name, value]) => sum + new TextEncoder().encode(`${name}: ${value}`).length, 0)
    if (
      new TextEncoder().encode(selectedUrl).length > MAX_HTTP_URL_BYTES || method.length > 16 ||
      method.toUpperCase() === 'CONNECT' ||
      headers.length > MAX_HTTP_HEADERS || size > MAX_HTTP_HEADER_BYTES || body.length > MAX_HTTP_BODY
    ) return Promise.reject(new TypeError('v86 HTTP relay limit'))
    return new Promise((resolve, reject) => {
      const id = allocate('http', { resolve, reject, pendingRead: undefined, ended: false })
      if (id == null) return reject(new Error('v86 HTTP relay limit'))
      if (!push('httpRequest', id, { url: selectedUrl, method, headers, bodyBase64: encode(body) })) {
        closeFlow(id, 'limit')
      }
    })
  }
  const response = (id, head) => {
    const flow = flows.get(id)
    if (flow?.kind !== 'http' || flow.closed || flow.resolve == null) throw new TypeError('Invalid v86 HTTP response')
    if (!Number.isInteger(head.status) || head.status < 100 || head.status > 599 ||
      typeof head.statusText !== 'string' || head.statusText.length > 128 ||
      !Array.isArray(head.headers) || head.headers.length > MAX_HTTP_HEADERS ||
      typeof head.url !== 'string' || head.url.length > MAX_HTTP_URL_BYTES) {
      return closeFlow(id, 'protocol')
    }
    const headers = new Headers(head.headers)
    const read = () => {
      if (flow.closed) return Promise.reject(flow.error ?? new Error('v86 HTTP relay closed'))
      if (flow.ended) return Promise.resolve({ done: true, value: undefined })
      if (flow.pendingRead != null) return Promise.reject(new Error('Concurrent v86 HTTP read'))
      return new Promise((resolveRead, rejectRead) => {
        flow.pendingRead = { resolve: resolveRead, reject: rejectRead }
        if (!push('httpPull', id)) closeFlow(id, 'limit')
      })
    }
    const result = {
      status: head.status,
      statusText: head.statusText,
      headers,
      redirected: head.redirected === true,
      url: head.url,
      body: { getReader: () => ({ read }) }
    }
    flow.resolve(result)
    flow.resolve = undefined
    flow.reject = undefined
  }

  globalThis.__holoVmNetworkSetup = vm => {
    adapter = vm.network_adapter
    if (adapter == null || typeof adapter.send !== 'function' || typeof adapter.receive !== 'function') {
      throw new TypeError('v86 network adapter unavailable')
    }
    adapter.fetch = requestHttp
    adapter.on_tcp_connection = (connection, packet) => {
      if (connection.sport === 80) return // pinned vendor owns its HTTP proxy
      const id = allocate('tcp', { connection })
      if (id == null) return connection.close()
      const address = packet?.ipv4?.dest?.join('.')
      if (typeof address !== 'string' || !push('tcpOpen', id, { address, port: connection.sport })) {
        return closeFlow(id, 'limit')
      }
      connection.on('data', bytes => pushTcpData(id, bytes))
      connection.on('shutdown', () => {
        const flow = flows.get(id)
        if (flow == null || flow.finQueued) return
        flow.finQueued = true
        if (!push('tcpFin', id)) closeFlow(id, 'limit')
      })
      connection.on('close', () => closeFlow(id))
      try {
        connection.accept(packet)
      } catch {
        closeFlow(id, 'protocol')
      }
    }
    const send = adapter.send.bind(adapter)
    adapter.send = bytes => {
      const packet = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      const endpoint = externalUdp(packet)
      if (endpoint == null) return send(bytes)
      let id = udpFlows.get(endpoint.key)
      if (id == null) {
        id = allocate('udp', { key: endpoint.key })
        if (id == null) return
        udpFlows.set(endpoint.key, id)
      }
      if (!push('udpFrame', id, { base64: encode(packet) })) closeFlow(id, 'limit')
      else touchUdp(id)
    }
  }
  globalThis.__holoVmNetworkDrain = limit => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new TypeError('Invalid v86 network drain')
    const drained = []
    while (drained.length < limit && (events.length > 0 || terminals.length > 0)) {
      const terminal = terminals[0]
      const ordinary = events[0]
      const item = terminal == null ? events.shift() : ordinary == null ? terminals.shift() :
        terminal.event.sequence < ordinary.event.sequence ? terminals.shift() : events.shift()
      if (item === ordinary) queuedBytes -= item.size
      drained.push(item.event)
    }
    return JSON.stringify({ events: drained, remaining: events.length + terminals.length })
  }
  globalThis.__holoVmNetworkDeliver = encoded => {
    const input = JSON.parse(encoded)
    const id = input?.streamId
    const flow = flows.get(id)
    if (!Number.isSafeInteger(id) || flow == null || flow.closed || typeof input.action !== 'string') {
      throw new TypeError('Invalid v86 network delivery')
    }
    if (flow.kind === 'tcp') {
      if (input.action === 'tcpClose') closeFlow(id)
      else if (input.action === 'tcpEnd') flow.connection.close()
      else if (input.action === 'tcpData') {
        const bytes = decode(input.base64)
        if (bytes.length > MAX_CHUNK) throw new TypeError('Invalid v86 TCP chunk')
        flow.authorized = true
        flow.pendingBytes = 0
        if (bytes.length > 0) flow.connection.write(bytes)
      } else throw new TypeError('Invalid v86 TCP action')
    } else if (flow.kind === 'udp') {
      if (input.action === 'tcpClose') closeFlow(id)
      else if (input.action === 'udpFrame') {
        const bytes = decode(input.base64)
        if (bytes.length > MAX_UDP_FRAME) throw new TypeError('Invalid v86 UDP frame')
        adapter.receive(bytes)
        touchUdp(id)
      } else throw new TypeError('Invalid v86 UDP action')
    } else if (input.action === 'httpHead') response(id, input.head)
    else if (input.action === 'httpChunk') {
      const bytes = decode(input.base64)
      if (bytes.length > MAX_CHUNK || flow.pendingRead == null) throw new TypeError('Invalid v86 HTTP chunk')
      flow.pendingRead.resolve({ done: false, value: bytes })
      flow.pendingRead = undefined
    } else if (input.action === 'httpEnd') {
      flow.ended = true
      flow.pendingRead?.resolve({ done: true, value: undefined })
      flow.pendingRead = undefined
      flows.delete(id)
    } else if (input.action === 'httpError') closeFlow(id, 'remote')
    else throw new TypeError('Invalid v86 HTTP action')
    return JSON.stringify({ accepted: true })
  }
  globalThis.__holoVmNetworkClose = () => {
    for (const id of [...flows.keys()]) closeFlow(id, 'environment')
    events.length = 0
    terminals.length = 0
    queuedBytes = 0
    adapter = undefined
  }
})()
