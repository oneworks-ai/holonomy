import { Buffer } from 'node:buffer'

import { V86FuseBridgeV1 } from '../../src/capability-process-v86-fuse.mjs'

const fsError = (errno, message) => Object.assign(new Error(message), { errno })

export const createV86FuseMemoryProbeV1 = () => {
  const files = new Map([['/workspace/input.txt', Buffer.from('HOST_TO_GUEST')]])
  const events = []
  const dispatch = async input => {
    events.push(Object.freeze({
      environmentId: input.environmentId,
      executableId: input.executableId,
      linuxPid: input.linuxPid,
      operation: input.operation,
      path: input.path,
      processId: input.processId
    }))
    if (input.operation === 'lookup' || input.operation === 'getattr') {
      const value = files.get(input.path)
      if (value == null) throw fsError(2, 'File not found')
      return { kind: 'file', size: value.byteLength }
    }
    if (input.operation === 'open') {
      if (!files.has(input.path)) throw fsError(2, 'File not found')
      if ((input.flags & 0x200) !== 0) files.set(input.path, Buffer.alloc(0))
      return null
    }
    if (input.operation === 'create') {
      files.set(input.path, Buffer.alloc(0))
      return { kind: 'file', size: 0 }
    }
    if (input.operation === 'read') {
      const value = files.get(input.path)
      if (value == null) throw fsError(2, 'File not found')
      return Uint8Array.from(value.subarray(input.offset, input.offset + input.size))
    }
    if (input.operation === 'write') {
      const current = files.get(input.path) ?? Buffer.alloc(0)
      const next = Buffer.alloc(Math.max(current.byteLength, input.offset + input.bytes.byteLength))
      current.copy(next)
      Buffer.from(input.bytes).copy(next, input.offset)
      files.set(input.path, next)
      return input.bytes.byteLength
    }
    if (input.operation === 'release') return null
    throw fsError(38, 'Unsupported filesystem operation')
  }
  const bridge = new V86FuseBridgeV1(dispatch)
  return Object.freeze({
    events,
    handleFilesystemRequest: input => bridge.handle(input),
    readFile: path => Uint8Array.from(files.get(path) ?? [])
  })
}
