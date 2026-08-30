;(() => {
  class BackendHeaders {
    constructor(input = []) {
      this.values = new Map()
      const entries = input instanceof BackendHeaders
        ? input.entries()
        : Array.isArray(input)
        ? input
        : Object.entries(input)
      for (const [name, value] of entries) this.set(name, value)
    }
    append(name, value) {
      const key = String(name).toLowerCase()
      const previous = this.values.get(key)
      this.values.set(key, previous == null ? String(value) : `${previous}, ${value}`)
    }
    delete(name) {
      this.values.delete(String(name).toLowerCase())
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

  class BackendURL {
    constructor(input) {
      const match = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/u.exec(String(input))
      if (match == null) throw new TypeError('Invalid v86 URL')
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
      if (match == null) throw new TypeError('Invalid v86 host')
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

  globalThis.__holoCreateV86NetworkBridge = ({ common, dispatch, processes }) => ({
    Headers: BackendHeaders,
    URL: BackendURL,
    fetch: async (input, init = {}) => {
      if (processes.size !== 1) throw new Error('v86 network process attribution unavailable')
      const [processId, source] = processes.entries().next().value
      const url = String(input)
      const parsed = new BackendURL(url)
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      const value = await dispatch('linuxProcessNetwork', {
        ...common(source, processId),
        headers: [...new BackendHeaders(init.headers).entries()],
        hostname: parsed.hostname,
        method: init.method ?? 'GET',
        port,
        transport: parsed.protocol === 'https:' ? 'tls' : 'tcp',
        url
      })
      const body = Uint8Array.from(value.bodyBytes ?? [])
      return Object.freeze({
        arrayBuffer: async () => body.slice().buffer,
        body: null,
        headers: new BackendHeaders(value.headers ?? []),
        redirected: value.redirected === true,
        status: value.status,
        statusText: value.statusText,
        url: value.url
      })
    }
  })
})()
