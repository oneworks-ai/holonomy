import { Buffer } from 'node:buffer'

import { NODE_NETWORK_LIMITS } from './network-validation.mjs'

const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/u
const responseError = code => Object.assign(new Error(`Node network ${code}`), { code })

const readHeaders = raw => {
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.length / 2 > NODE_NETWORK_LIMITS.maxHeaders) {
    throw responseError('response_headers_invalid')
  }
  const headers = []
  let bytes = 0
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]
    const value = raw[index + 1]
    if (typeof name !== 'string' || typeof value !== 'string' || !HEADER_NAME.test(name) || /[\0\r\n]/u.test(value)) {
      throw responseError('response_headers_invalid')
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (bytes > NODE_NETWORK_LIMITS.maxHeaderBytes) throw responseError('response_headers_invalid')
    headers.push(Object.freeze([name.toLowerCase(), value]))
  }
  return Object.freeze(headers)
}

export const readNetworkResponse = (response, maxResponseBytes = NODE_NETWORK_LIMITS.maxResponseBytes) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let ended = false
    const fail = error => {
      for (const chunk of chunks) chunk.fill(0)
      reject(error?.code == null ? responseError('response_failed') : error)
    }
    response.on('data', chunk => {
      bytes += chunk.byteLength
      if (bytes > maxResponseBytes) {
        response.destroy(responseError('response_limit_exceeded'))
        return
      }
      chunks.push(Uint8Array.from(chunk))
    })
    response.once('aborted', () => fail(responseError('response_failed')))
    response.once('error', fail)
    response.once('close', () => {
      if (!ended) fail(responseError('response_failed'))
    })
    response.once('end', () => {
      ended = true
      try {
        if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 999) {
          throw responseError('response_status_invalid')
        }
        const body = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.byteLength
          chunk.fill(0)
        }
        const statusText = typeof response.statusMessage === 'string' && !/[\0\r\n]/u.test(response.statusMessage)
          ? response.statusMessage
          : ''
        resolve(
          Object.freeze({
            body,
            headers: readHeaders(response.rawHeaders ?? []),
            status: response.statusCode,
            statusText
          })
        )
      } catch (error) {
        fail(error)
      }
    })
  })
