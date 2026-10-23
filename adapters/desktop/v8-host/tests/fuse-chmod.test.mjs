import { describe, expect, it } from 'vitest'
import { V86_FUSE_OPERATIONS_V1 as op } from '../../../../backends/v86/host/fuse-protocol.mjs'
import { V86FuseBridgeV1 } from '../../../../backends/v86/host/fuse.mjs'

let unique = 0n
const stat = (kind, mode) => ({
  kind,
  mode,
  size: 0,
  atimeNs: '0',
  mtimeNs: '0',
  ctimeNs: '0'
})
const text = value => new TextEncoder().encode(`${value}\0`)
const bytes = (length, handle = 0n) => {
  const output = new Uint8Array(length)
  if (length >= 8) new DataView(output.buffer).setBigUint64(0, handle, true)
  return output
}
const modeBody = (value, handle) => {
  const body = new Uint8Array(88)
  const data = new DataView(body.buffer)
  data.setUint32(0, handle == null ? 1 : 1 | 64, true)
  if (handle != null) data.setBigUint64(8, handle, true)
  data.setUint32(68, value, true)
  return body
}
const invoke = (bridge, opcode, body = new Uint8Array(), nodeId = 1n) => {
  const payload = new Uint8Array(40 + body.length)
  const view = new DataView(payload.buffer)
  view.setUint32(0, payload.length, true)
  view.setUint32(4, opcode, true)
  view.setBigUint64(8, ++unique, true)
  view.setBigUint64(16, nodeId, true)
  view.setUint32(32, 42, true)
  payload.set(body, 40)
  return bridge.handle({
    environmentId: 'chmod-test',
    executableId: 'git',
    generation: 1,
    processId: 2,
    processResourceId: 'process-2',
    scope: 'processTree',
    payload,
    signal: new AbortController().signal,
    policy: {}
  })
}
const code = response => new DataView(response.buffer, response.byteOffset).getInt32(4, true)
const id = response => new DataView(response.buffer, response.byteOffset).getBigUint64(16, true)
const attrMode = response => new DataView(response.buffer, response.byteOffset).getUint32(92, true)

describe('v86 FUSE chmod handoff', () => {
  it('forwards pure MODE through path, file FH and directory FH with real readback', async () => {
    const calls = []
    const bridge = new V86FuseBridgeV1(input => {
      calls.push(input)
      const kind = input.path.endsWith('/dir') ? 'directory' : 'file'
      if (input.operation === 'lookup') return stat(kind, kind === 'directory' ? 0o040755 : 0o100644)
      if (input.operation === 'open') return 'pinned-file'
      if (input.operation === 'opendir') return { handle: 'pinned-directory', entries: [] }
      if (input.operation === 'setattr') {
        return stat(kind, (kind === 'directory' ? 0o040000 : 0o100000) | input.mode)
      }
      return null
    })
    const fileNode = id(await invoke(bridge, op.lookup, text('file')))
    const directoryNode = id(await invoke(bridge, op.lookup, text('dir')))
    const fileHandle = id(await invoke(bridge, op.open, bytes(8), fileNode))
    const directoryHandle = id(await invoke(bridge, op.opendir, bytes(8), directoryNode))

    const pathResult = await invoke(bridge, op.setattr, modeBody(0o100744), fileNode)
    expect(code(pathResult)).toBe(0)
    expect(attrMode(pathResult)).toBe(0o100744)
    expect(calls.at(-1)).toMatchObject({
      operation: 'setattr',
      path: '/workspace/file',
      mode: 0o744,
      expectedKind: 'file'
    })
    expect(calls.at(-1)).not.toHaveProperty('handle')

    const bareResult = await invoke(bridge, op.setattr, modeBody(0o600), fileNode)
    expect(code(bareResult)).toBe(0)
    expect(attrMode(bareResult)).toBe(0o100600)
    expect(calls.at(-1)).not.toHaveProperty('expectedKind')

    const fileResult = await invoke(bridge, op.setattr, modeBody(0o100640, fileHandle), fileNode)
    expect(code(fileResult)).toBe(0)
    expect(attrMode(fileResult)).toBe(0o100640)
    expect(calls.at(-1)).toMatchObject({
      operation: 'setattr',
      path: '/workspace/file',
      mode: 0o640,
      expectedKind: 'file',
      handle: 'pinned-file',
      handleKind: 'file'
    })

    const directoryResult = await invoke(
      bridge,
      op.setattr,
      modeBody(0o040700, directoryHandle),
      directoryNode
    )
    expect(code(directoryResult)).toBe(0)
    expect(attrMode(directoryResult)).toBe(0o040700)
    expect(calls.at(-1)).toMatchObject({
      operation: 'setattr',
      path: '/workspace/dir',
      mode: 0o700,
      expectedKind: 'directory',
      handle: 'pinned-directory',
      handleKind: 'directory'
    })

    const before = calls.length
    expect(code(await invoke(bridge, op.setattr, modeBody(0o040600), fileNode))).toBe(-22)
    expect(code(await invoke(bridge, op.setattr, modeBody(0o100600, directoryHandle), directoryNode)))
      .toBe(-22)
    expect(code(await invoke(bridge, op.setattr, modeBody(0o040600, fileHandle), fileNode)))
      .toBe(-22)
    expect(code(await invoke(bridge, op.setattr, modeBody(0o100600, fileHandle), directoryNode)))
      .toBe(-9)
    const mixed = modeBody(0o100600, fileHandle)
    new DataView(mixed.buffer).setUint32(0, 1 | 8 | 64, true)
    expect(code(await invoke(bridge, op.setattr, mixed, fileNode))).toBe(-95)
    expect(calls).toHaveLength(before)
    bridge.releaseEnvironment('chmod-test')
  })

  it('rejects a MODE response with missing or unchanged mode', async () => {
    let readback
    const bridge = new V86FuseBridgeV1(input => {
      if (input.operation === 'lookup') return stat('file', 0o100644)
      if (input.operation === 'setattr') return readback
      return null
    })
    const node = id(await invoke(bridge, op.lookup, text('file')))
    readback = { ...stat('file', 0o100600), mode: undefined }
    expect(code(await invoke(bridge, op.setattr, modeBody(0o100600), node))).toBe(-5)
    readback = stat('file', 0o100644)
    expect(code(await invoke(bridge, op.setattr, modeBody(0o100600), node))).toBe(-5)
    bridge.releaseEnvironment('chmod-test')
  })
})
