const normalizePath = (input) => {
  const trailingSlash = input.endsWith('/')
  const output = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') output.pop()
    else output.push(segment)
  }
  return `/${output.join('/')}${trailingSlash && output.length > 0 ? '/' : ''}`
}

const decodePart = value => decodeURIComponent(value.replaceAll('+', ' '))
const encodePart = value => encodeURIComponent(value).replaceAll('%20', '+')

export class RuntimeURLSearchParams {
  #entries
  #update

  constructor(value = '', update = () => {}) {
    const source = String(value).replace(/^\?/u, '')
    this.#entries = source === ''
      ? []
      : source.split('&').map(item => {
        const split = item.indexOf('=')
        return split < 0
          ? [decodePart(item), '']
          : [decodePart(item.slice(0, split)), decodePart(item.slice(split + 1))]
      })
    this.#update = update
  }

  *entries() {
    for (const entry of this.#entries) yield [...entry]
  }

  get(name) {
    return this.#entries.find(entry => entry[0] === String(name))?.[1] ?? null
  }

  keys() {
    return this.#entries.map(entry => entry[0]).values()
  }

  set(name, value) {
    const key = String(name)
    const next = this.#entries.filter(entry => entry[0] !== key)
    next.push([key, String(value)])
    this.#entries = next
    this.#update(this.toString())
  }

  toString() {
    return this.#entries.map(([name, value]) => `${encodePart(name)}=${encodePart(value)}`).join('&')
  }

  [Symbol.iterator]() {
    return this.entries()
  }
}

const parseAbsolute = (value) => {
  const match = /^([a-z][a-z\d+.-]*:)(?:\/\/([^/?#]*))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/iu.exec(value)
  if (match == null) throw new TypeError('Invalid URL')
  const authority = match[2] ?? ''
  const credentialsEnd = authority.lastIndexOf('@')
  const credentials = credentialsEnd >= 0 ? authority.slice(0, credentialsEnd) : ''
  const host = credentialsEnd >= 0 ? authority.slice(credentialsEnd + 1) : authority
  const credentialSeparator = credentials.indexOf(':')
  const bracketEnd = host.startsWith('[') ? host.indexOf(']') : -1
  const portSeparator = bracketEnd >= 0 ? (host[bracketEnd + 1] === ':' ? bracketEnd + 1 : -1) : host.lastIndexOf(':')
  return {
    hash: match[5] ?? '',
    hostname: portSeparator > 0 ? host.slice(0, portSeparator) : host,
    password: credentialSeparator >= 0 ? credentials.slice(credentialSeparator + 1) : '',
    pathname: normalizePath(match[3] || '/'),
    port: portSeparator > 0 ? host.slice(portSeparator + 1) : '',
    protocol: match[1].toLowerCase(),
    search: match[4] ?? '',
    username: credentialSeparator >= 0 ? credentials.slice(0, credentialSeparator) : credentials
  }
}

export class RuntimeURL {
  constructor(value, base) {
    const input = String(value)
    if (/^[a-z][a-z\d+.-]*:/iu.test(input)) {
      this.assign(parseAbsolute(input))
      return
    }
    if (base === undefined) throw new TypeError('Invalid URL')
    const parent = base instanceof RuntimeURL ? base : new RuntimeURL(String(base))
    const hashIndex = input.indexOf('#')
    const withoutHash = hashIndex < 0 ? input : input.slice(0, hashIndex)
    const queryIndex = withoutHash.indexOf('?')
    const relativePath = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex)
    const parentDirectory = parent.pathname.endsWith('/')
      ? parent.pathname
      : parent.pathname.slice(0, parent.pathname.lastIndexOf('/') + 1)
    this.assign({
      hash: hashIndex < 0 ? '' : input.slice(hashIndex),
      hostname: parent.hostname,
      password: parent.password,
      pathname: normalizePath(relativePath.startsWith('/') ? relativePath : parentDirectory + relativePath),
      port: parent.port,
      protocol: parent.protocol,
      search: queryIndex < 0 ? '' : withoutHash.slice(queryIndex),
      username: parent.username
    })
  }

  assign(parts) {
    this.protocol = parts.protocol
    this.username = parts.username
    this.password = parts.password
    this.hostname = parts.hostname
    this.port = parts.port
    this.pathname = parts.pathname
    this.search = parts.search
    this.hash = parts.hash
  }

  get host() {
    return this.port === '' ? this.hostname : `${this.hostname}:${this.port}`
  }

  get href() {
    return this.toString()
  }

  get origin() {
    return `${this.protocol}//${this.host}`
  }

  get searchParams() {
    return new RuntimeURLSearchParams(this.search, value => {
      this.search = value === '' ? '' : `?${value}`
    })
  }

  toString() {
    const credentials = this.username === ''
      ? ''
      : `${this.username}${this.password === '' ? '' : `:${this.password}`}@`
    return `${this.protocol}//${credentials}${this.host}${this.pathname}${this.search}${this.hash}`
  }
}

export class RuntimeTextDecoder {
  constructor(label = 'utf-8', options = {}) {
    if (!/^utf-?8$/iu.test(String(label))) throw new RangeError('Only UTF-8 is supported')
    this.fatal = options.fatal === true
  }

  decode(input = new Uint8Array()) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    let output = ''
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index++]
      if (first < 0x80) {
        output += String.fromCodePoint(first)
        continue
      }
      const width = first < 0xE0 ? 2 : first < 0xF0 ? 3 : first < 0xF8 ? 4 : 0
      if (width === 0 || index + width - 1 > bytes.length) return this.invalid(output)
      let value = first & (0x7F >> width)
      for (let offset = 1; offset < width; offset += 1) {
        const next = bytes[index++]
        if ((next & 0xC0) !== 0x80) return this.invalid(output)
        value = (value << 6) | (next & 0x3F)
      }
      if (
        (width === 2 && value < 0x80) ||
        (width === 3 && value < 0x800) ||
        (width === 4 && value < 0x10000) ||
        value > 0x10FFFF ||
        (value >= 0xD800 && value <= 0xDFFF)
      ) return this.invalid(output)
      output += String.fromCodePoint(value)
    }
    return output
  }

  invalid(prefix) {
    if (this.fatal) throw new TypeError('Invalid UTF-8')
    return `${prefix}\uFFFD`
  }
}
