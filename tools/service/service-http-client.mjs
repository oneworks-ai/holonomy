import { Buffer } from 'node:buffer'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { normalizeServiceError, serviceError } from './errors.mjs'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const consumeResponse = async response => {
  const chunks = []
  let bytes = 0
  for await (const chunk of response) {
    bytes += chunk.byteLength
    if (bytes > MAX_RESPONSE_BYTES) throw serviceError('service.limit_exceeded', 'Service response exceeds its limit')
    chunks.push(chunk)
  }
  let value = {}
  if (bytes > 0) {
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw serviceError('service.unavailable', 'Holonomy Service response is invalid')
    }
  }
  if ((response.statusCode ?? 500) >= 400) {
    const remote = value.error
    throw normalizeServiceError(
      serviceError(remote?.code ?? 'service.unavailable', remote?.message ?? 'Request failed', {
        details: remote?.details,
        retryable: remote?.retryable === true,
        status: response.statusCode
      })
    )
  }
  return value
}

export async function requestJson(baseUrl, path, options) {
  const url = new URL(path, baseUrl)
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  const body = options.body == null ? undefined : Buffer.from(JSON.stringify(options.body))
  return await new Promise((resolve, reject) => {
    const outgoing = request(url, {
      ca: options.ca,
      headers: {
        ...(options.token == null ? {} : { authorization: `Bearer ${options.token}` }),
        ...(body == null ? {} : { 'content-length': body.byteLength, 'content-type': 'application/json' }),
        ...(options.headers ?? {})
      },
      method: options.method ?? 'GET'
    }, response => consumeResponse(response).then(resolve, reject))
    outgoing.once('error', () => reject(serviceError('service.unavailable', 'Holonomy Service is unavailable')))
    if (body != null) outgoing.write(body)
    outgoing.end()
  })
}
