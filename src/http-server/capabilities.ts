export type HttpServerCapabilityStatus = 'partial' | 'supported' | 'unsupported'

const supported = (notes: readonly string[]) =>
  Object.freeze({ notes: Object.freeze(notes), status: 'supported' as const })
const partial = (notes: readonly string[]) => Object.freeze({ notes: Object.freeze(notes), status: 'partial' as const })
const unsupported = (notes: readonly string[]) =>
  Object.freeze({ notes: Object.freeze(notes), status: 'unsupported' as const })

export const HTTP_SERVER_CAPABILITY_MATRIX = Object.freeze({
  features: Object.freeze({
    'node:http.createServer': supported(['Bound NativePort virtual-host listener.']),
    'node:http.request': partial(['method/url/headers, byte-mode body stream, aborted event.']),
    'node:http.response': partial(['setHeader/writeHead/write/end with acknowledged write backpressure.']),
    'node:http.server': partial(['listen/close/address/ref/unref and lifecycle events.']),
    'node:http.upgrade': partial(['Virtual upgrade socket accepted only by the bound ws server.']),
    'node:https': unsupported(['TLS termination belongs to an authorized native provider.']),
    'socket.raw': unsupported(['No guest-visible TCP, UDP or file descriptor API.']),
    'websocket.client': unsupported(['M2 v1 provides server-side accepted connections only.']),
    'websocket.server': partial(['ws noServer/handleUpgrade and message/send/close subset.'])
  }),
  module: 'host.http-server',
  version: 1
})
