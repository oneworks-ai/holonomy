// Build-only leaves for the private v86 HTTP relay. This isolate does not run
// the Holonomy Runtime or expose these values to the Guest Linux process.
import { WebHeaders } from '../../../../packages/capabilities/network/src/web/web-headers.ts'
import { RuntimeTextDecoder, RuntimeURL } from '../../../node/src/runtime-web-standards.mjs'

class V86ProxyURL extends RuntimeURL {
  get host() {
    return super.host
  }

  set host(value) {
    const parsed = new RuntimeURL(`http://${String(value)}/`)
    if (
      parsed.username !== '' || parsed.password !== '' || parsed.hostname === '' ||
      parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
    ) throw new TypeError('Invalid v86 proxy Host header')
    this.hostname = parsed.hostname
    this.port = parsed.port
  }
}

Object.assign(globalThis, {
  Headers: WebHeaders,
  TextDecoder: RuntimeTextDecoder,
  URL: V86ProxyURL,
  location: Object.freeze({ protocol: 'http:' })
})
