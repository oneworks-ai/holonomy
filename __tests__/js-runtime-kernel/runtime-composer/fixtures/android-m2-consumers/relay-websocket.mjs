import { Buffer } from 'node:buffer'
import WebSocket from 'ws'

export const openRelayChannel = (url) => {
  const socket = new WebSocket(url)
  socket.on('message', data => Buffer.from(data))
  return socket
}
