import { isIP } from 'node:net'

export const processNetworkFailureV1 = code => {
  const error = new Error('v86 process network bridge failed')
  Object.defineProperty(error, 'code', { enumerable: true, value: code })
  throw error
}

export const normalizeProcessNetworkHostnameV1 = value => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    return processNetworkFailureV1('process.network_endpoint_unsupported')
  }
  const normalized = value.toLowerCase()
  if (isIP(normalized) !== 0) return normalized
  try {
    const url = new URL(`http://${normalized}/`)
    if (url.hostname !== normalized || url.port !== '' || url.username !== '' || url.password !== '') {
      return processNetworkFailureV1('process.network_endpoint_unsupported')
    }
  } catch {
    return processNetworkFailureV1('process.network_endpoint_unsupported')
  }
  return normalized
}

export const processNetworkEndpointV1 = value => {
  let url
  try {
    url = new URL(value)
  } catch {
    return processNetworkFailureV1('process.network_url_invalid')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' ||
    url.hash !== ''
  ) return processNetworkFailureV1('process.network_endpoint_unsupported')
  const hostname = normalizeProcessNetworkHostnameV1(url.hostname)
  if (isIP(hostname) === 0) return processNetworkFailureV1('process.network_endpoint_unsupported')
  return Object.freeze({
    hostname,
    port: url.port === '' ? url.protocol === 'https:' ? 443 : 80 : Number(url.port),
    transport: url.protocol === 'https:' ? 'tls' : 'tcp',
    url
  })
}

export const leaseProcessNetworkResponseV1 = (response, release) => {
  if (!(response instanceof Response)) {
    release()
    return processNetworkFailureV1('provider.protocol_error')
  }
  if (response.body == null) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream({
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
    async pull(controller) {
      try {
        const value = await reader.read()
        if (value.done) {
          release()
          controller.close()
        } else controller.enqueue(value.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    }
  })
  const output = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  })
  Object.defineProperties(output, {
    redirected: { value: response.redirected },
    type: { value: response.type },
    url: { value: response.url }
  })
  return output
}
