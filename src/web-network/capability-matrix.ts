export type WebNetworkCapabilityStatus = 'partial' | 'supported' | 'unsupported'

export interface WebNetworkCapability {
  readonly notes: readonly string[]
  readonly status: WebNetworkCapabilityStatus
}

export const WEB_NETWORK_CAPABILITY_MATRIX = Object.freeze({
  version: 1,
  module: 'host.network',
  features: Object.freeze(
    {
      'fetch.client': {
        notes: ['http/https only', 'no ambient cookies or system credentials'],
        status: 'supported'
      },
      'fetch.abort-deadline': {
        notes: [
          'injected or fallback AbortSignal via explicit Bridge cancel',
          'Bridge-owned timeout/deadline scheduler'
        ],
        status: 'supported'
      },
      'fetch.redirect': {
        notes: ['follow/error/manual', 'every hop is re-authorized'],
        status: 'supported'
      },
      'fetch.response.clone': {
        notes: ['only null or constructor-owned bounded bodies', 'native streams return network.not_supported'],
        status: 'partial'
      },
      'fetch.streaming': {
        notes: ['binary chunks', 'pull credit', 'bounded collection'],
        status: 'supported'
      },
      'websocket.client': {
        notes: ['deferred: no current Relay consumer requires this in M2 fetch v1'],
        status: 'unsupported'
      },
      'websocket.server': {
        notes: ['HTTP fetch v1 does not include a WebSocket server'],
        status: 'unsupported'
      },
      'socket.raw': {
        notes: ['no raw TCP or UDP access'],
        status: 'unsupported'
      },
      'tls.raw': {
        notes: ['TLS is owned by an authorized native HTTP/WebSocket provider'],
        status: 'unsupported'
      },
      'dgram': {
        notes: ['no datagram API'],
        status: 'unsupported'
      }
    } satisfies Record<string, WebNetworkCapability>
  )
})
