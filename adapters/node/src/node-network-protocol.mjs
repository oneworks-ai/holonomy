export const NODE_NETWORK_MODULE = 'host.network'
export const NODE_NETWORK_OPERATIONS = Object.freeze({
  cancel: 'v1.http.cancel',
  close: 'v1.http.close',
  finish: 'v1.http.finish-body',
  open: 'v1.http.open-body',
  read: 'v1.http.read-body',
  request: 'v1.http.request',
  write: 'v1.http.write-body'
})
export const DEFAULT_NETWORK_CHUNK_BYTES = 64 * 1024
export const MAX_NETWORK_CHUNK_BYTES = 8 * 1024 * 1024

export const networkSuccess = value => ({ ok: true, value })
export const sendNetworkResult = (sink, id, value, resources) =>
  sink({
    id,
    ...(resources == null ? {} : { resources }),
    type: 'result',
    value: networkSuccess(value)
  })
export const sendNetworkResponse = (sink, id, response, hasBody) =>
  sendNetworkResult(sink, id, {
    hasBody,
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
    url: response.url
  })
export const rejectNetworkCall = (sink, id, code, domain) =>
  sink({
    error: { code, ...(domain == null ? {} : { domain }) },
    id,
    type: 'error'
  })
export const hasExactKeys = (value, keys) =>
  value != null && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

export const consumeNetworkBody = parts => {
  const bytes = parts.reduce((total, item) => total + item.byteLength, 0)
  if (bytes === 0) return undefined
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const item of parts) {
    body.set(item, offset)
    offset += item.byteLength
    item.fill(0)
  }
  return body
}

export const splitNetworkBody = (body, maxChunkBytes) => {
  const chunks = []
  for (let index = 0; index < body.byteLength; index += maxChunkBytes) {
    chunks.push(body.slice(index, index + maxChunkBytes))
  }
  body.fill(0)
  return chunks
}
