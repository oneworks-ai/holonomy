export const HTTP_SERVER_NATIVE_MODULE = 'host.http-server'
export const HTTP_SERVER_OPERATION_VERSION = 1

export const HTTP_SERVER_OPERATIONS = Object.freeze({
  exchange: Object.freeze({ abort: 'v1.exchange.abort' }),
  request: Object.freeze({ read: 'v1.request.read' }),
  response: Object.freeze({
    end: 'v1.response.end',
    start: 'v1.response.start',
    write: 'v1.response.write'
  }),
  server: Object.freeze({
    accept: 'v1.server.accept',
    close: 'v1.server.close',
    open: 'v1.server.open'
  }),
  websocket: Object.freeze({
    accept: 'v1.websocket.accept',
    close: 'v1.websocket.close',
    read: 'v1.websocket.read',
    send: 'v1.websocket.send'
  })
})

export const HTTP_SERVER_RESOURCE_TYPES = Object.freeze({
  exchange: 'http.exchange',
  server: 'http.server',
  websocket: 'http.websocket'
})
