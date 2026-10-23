import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  decodeV86FuseAccessV1,
  decodeV86FuseFsyncV1,
  decodeV86FuseRequestV1,
  decodeV86FuseSetattrV1,
  encodeV86FuseAttrV1
} from '../../../../backends/v86/host/fuse-protocol.mjs'

const request = body => ({ body, unique: 7n })
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

describe('pinned Linux 6.8.12 FUSE wire layout', () => {
  it('decodes ACCESS as an exact eight byte mask and reserved word', () => {
    const body = new Uint8Array(8)
    view(body).setUint32(0, 5, true)
    expect(decodeV86FuseAccessV1(request(body))).toEqual({ mask: 5 })
    view(body).setUint32(0, 8, true)
    expect(() => decodeV86FuseAccessV1(request(body))).toThrow()
    view(body).setUint32(0, 5, true)
    view(body).setUint32(4, 1, true)
    expect(() => decodeV86FuseAccessV1(request(body))).toThrow()
    expect(() => decodeV86FuseAccessV1(request(new Uint8Array(9)))).toThrow()
  })

  it('decodes FSYNC and FSYNCDIR as an exact sixteen byte handle and FDATASYNC bit', () => {
    const body = new Uint8Array(16)
    view(body).setBigUint64(0, 99n, true)
    view(body).setUint32(8, 1, true)
    expect(decodeV86FuseFsyncV1(request(body))).toEqual({ handleId: 99n, datasync: true })
    view(body).setUint32(8, 2, true)
    expect(() => decodeV86FuseFsyncV1(request(body))).toThrow()
    view(body).setUint32(8, 0, true)
    view(body).setUint32(12, 1, true)
    expect(() => decodeV86FuseFsyncV1(request(body))).toThrow()
    expect(() => decodeV86FuseFsyncV1(request(new Uint8Array(17)))).toThrow()
  })

  it('rejects unsupported or mixed SETATTR before it can mutate a file', () => {
    const body = new Uint8Array(88)
    const data = view(body)
    data.setUint32(0, 1 | 8, true) // FATTR_MODE | FATTR_SIZE
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    data.setUint32(0, 8 | 16, true) // FATTR_SIZE | FATTR_ATIME
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    data.setUint32(0, 8 | 512, true) // FATTR_SIZE | FATTR_LOCKOWNER
    data.setBigUint64(16, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true)
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    expect(() => decodeV86FuseSetattrV1(request(new Uint8Array(89)))).toThrow()
  })

  it('decodes the captured Linux Git MODE body at byte 68 and rejects unsafe fields', () => {
    const observed = Buffer.from(
      '0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e481000000000000000000000000000000000000',
      'hex'
    )
    expect(observed.byteLength).toBe(88)
    expect(decodeV86FuseSetattrV1(request(observed))).toEqual({
      kind: 'mode',
      mode: 0o744,
      modeKind: 'file'
    })
    const body = new Uint8Array(88)
    const data = view(body)
    data.setUint32(0, 1 | 64, true) // FATTR_MODE | FATTR_FH
    data.setBigUint64(8, 17n, true)
    data.setUint32(68, 0o040700, true)
    expect(decodeV86FuseSetattrV1(request(body))).toEqual({
      kind: 'mode',
      handleId: 17n,
      mode: 0o700,
      modeKind: 'directory'
    })
    data.setUint32(68, 0o1004755, true) // SUID is outside the chmod increment.
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    data.setUint32(68, 0o120755, true) // Symlink type is unsupported.
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    data.setUint32(68, 0o100644, true)
    data.setUint32(72, 1, true) // unused4 remains zero.
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    data.setUint32(72, 0, true)
    data.setUint32(0, 1 | 16 | 64, true) // MODE + ATIME is not atomic.
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
  })

  it('accepts the observed touch NOW wire and rejects oversized explicit time', () => {
    const body = new Uint8Array(88)
    const data = view(body)
    data.setUint32(0, 0x1B0, true)
    data.setBigUint64(32, 1700000000n, true)
    data.setBigUint64(40, 1700000000n, true)
    data.setUint32(56, 123456789, true)
    data.setUint32(60, 987654321, true)
    expect(decodeV86FuseSetattrV1(request(body))).toEqual({
      kind: 'times',
      atime: { kind: 'now' },
      mtime: { kind: 'now' }
    })
    data.setUint32(0, 16 | 32, true)
    data.setUint32(56, 1000000000, true)
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
    data.setUint32(56, 0, true)
    data.setBigUint64(32, 253402300800n, true)
    expect(() => decodeV86FuseSetattrV1(request(body))).toThrow()
  })

  it('rejects a frame larger than the Guest FUSE receive buffer', () => {
    const frame = new Uint8Array(128 * 1024 + 1)
    view(frame).setUint32(0, frame.byteLength, true)
    view(frame).setBigUint64(8, 7n, true)
    expect(() => decodeV86FuseRequestV1(frame)).toThrow()
  })

  it('preserves nanosecond metadata in the FUSE attr response', () => {
    const response = encodeV86FuseAttrV1(request(new Uint8Array()), 3n, {
      kind: 'file',
      size: 12,
      mode: 0o100640,
      atimeNs: '1700000000123456789',
      mtimeNs: '1700000000987654321',
      ctimeNs: '1700000000000000001'
    })
    const data = view(response)
    expect(data.getBigUint64(56, true)).toBe(1700000000n)
    expect(data.getBigUint64(64, true)).toBe(1700000000n)
    expect(data.getBigUint64(72, true)).toBe(1700000000n)
    expect(data.getUint32(80, true)).toBe(123456789)
    expect(data.getUint32(84, true)).toBe(987654321)
    expect(data.getUint32(88, true)).toBe(1)
    expect(data.getUint32(92, true)).toBe(0o100640)
  })

  it('preserves pre-epoch timestamps using the kernel two-complement seconds layout', () => {
    const response = encodeV86FuseAttrV1(request(new Uint8Array()), 3n, {
      kind: 'file',
      size: 0,
      mode: 0o100600,
      atimeNs: '-1',
      mtimeNs: '-1000000000',
      ctimeNs: '0'
    })
    const data = view(response)
    expect(data.getBigInt64(56, true)).toBe(-1n)
    expect(data.getUint32(80, true)).toBe(999999999)
    expect(data.getBigInt64(64, true)).toBe(-1n)
    expect(data.getUint32(84, true)).toBe(0)
  })

  it('requires real mode with type agreeing with the metadata kind', () => {
    const base = {
      kind: 'directory',
      size: 0,
      mode: 0o040711,
      atimeNs: '0',
      mtimeNs: '0',
      ctimeNs: '0'
    }
    expect(view(encodeV86FuseAttrV1(request(new Uint8Array()), 3n, base)).getUint32(92, true))
      .toBe(0o040711)
    expect(() => encodeV86FuseAttrV1(request(new Uint8Array()), 3n, { ...base, mode: 0o100711 }))
      .toThrow()
    expect(() => encodeV86FuseAttrV1(request(new Uint8Array()), 3n, { ...base, mode: undefined }))
      .toThrow()
  })
})
