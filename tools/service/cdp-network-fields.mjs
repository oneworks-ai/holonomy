import { isIP } from 'node:net'

const headerEntries = entries => Array.isArray(entries) ? entries : []

export const cdpHeaders = entries => {
  const values = new Map()
  for (const entry of headerEntries(entries)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue
    const normalized = entry[0].toLowerCase()
    const previous = values.get(normalized)
    values.set(normalized, {
      name: previous?.name ?? entry[0],
      value: previous == null ? entry[1] : `${previous.value}\n${entry[1]}`
    })
  }
  return Object.fromEntries([...values.values()].map(entry => [entry.name, entry.value]))
}

const headerValue = (entries, name) => {
  const normalized = name.toLowerCase()
  return headerEntries(entries).find(entry => (
    Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].toLowerCase() === normalized
  ))?.[1] ?? ''
}

const contentType = entries => {
  const value = headerValue(entries, 'content-type')
  const [mimeType = ''] = value.split(';', 1)
  const charset = /(?:^|;)\s*charset\s*=\s*"?([^;"\s]+)/iu.exec(value)?.[1] ?? ''
  return {
    charset: charset.toLowerCase(),
    mimeType: mimeType.trim().toLowerCase() || 'application/octet-stream'
  }
}

const endpoint = event => {
  if (event.source !== 'real') return undefined
  try {
    const url = new URL(event.url)
    const host = url.hostname.replace(/^\[|\]$/gu, '')
    if (isIP(host) === 0) return undefined
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
    return Number.isSafeInteger(port) && port > 0 && port <= 65_535
      ? { remoteIPAddress: host, remotePort: port }
      : undefined
  } catch {
    return undefined
  }
}

export const ipAddressSpace = event => {
  const remote = endpoint(event)?.remoteIPAddress
  if (remote == null) return 'Unknown'
  if (remote === '::1' || remote.startsWith('127.')) return 'Loopback'
  return 'Unknown'
}

export const resourceTiming = (requestTimestampMs, responseTimestampMs) => {
  const elapsed = Math.max(0, responseTimestampMs - requestTimestampMs)
  return {
    connectEnd: -1,
    connectStart: -1,
    dnsEnd: -1,
    dnsStart: -1,
    proxyEnd: -1,
    proxyStart: -1,
    pushEnd: 0,
    pushStart: 0,
    receiveHeadersEnd: elapsed,
    receiveHeadersStart: elapsed,
    requestTime: requestTimestampMs / 1_000,
    sendEnd: 0,
    sendStart: 0,
    sslEnd: -1,
    sslStart: -1,
    workerFetchStart: -1,
    workerReady: -1,
    workerRespondWithSettled: -1,
    workerStart: -1
  }
}

export const cdpResponse = (event, state, wallTimeMs) => {
  const type = contentType(event.headers)
  let secure = false
  try {
    secure = event.source === 'real' && new URL(event.url).protocol === 'https:'
  } catch {
    // Invalid diagnostics are rejected by the caller; retain a neutral projection here.
  }
  return {
    ...type,
    connectionReused: false,
    encodedDataLength: 0,
    fromDiskCache: false,
    fromPrefetchCache: false,
    fromServiceWorker: false,
    headers: cdpHeaders(event.headers),
    holonomySource: event.source,
    protocol: event.source === 'mock' ? 'holonomy-mock' : 'http/1.1',
    requestHeaders: cdpHeaders(state.requestHeaders),
    responseTime: wallTimeMs / 1_000,
    securityState: secure ? 'secure' : 'neutral',
    status: event.status,
    statusText: event.statusText,
    timing: resourceTiming(state.requestTimestampMs, event.timestampMs),
    url: event.url,
    ...endpoint(event)
  }
}
