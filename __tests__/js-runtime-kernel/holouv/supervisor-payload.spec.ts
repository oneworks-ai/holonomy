import { describe, expect, it } from 'vitest'

import {
  decodeHoloUvCapabilityRequestV1,
  decodeHoloUvCapabilityResponseV1,
  decodeHoloUvCompletionPayloadV1,
  decodeHoloUvErrorPayloadV1,
  decodeHoloUvSpawnedPayloadV1,
  encodeHoloUvCapabilityRequestV1,
  encodeHoloUvCapabilityResponseV1,
  encodeHoloUvCompletionPayloadV1,
  encodeHoloUvEnvironmentConfigurationV1,
  encodeHoloUvSignalPayloadV1,
  encodeHoloUvSpawnPayloadV1,
  encodeHoloUvSpawnedPayloadV1,
  requireEmptyHoloUvPayloadV1
} from '@holonomyjs/holouv'

const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex.match(/.{2}/gu)?.map(value => Number.parseInt(value, 16)) ?? []
  )

describe('holouv supervisor payload codec', () => {
  it('matches the C supervisor completion, spawned, signal and error wire bytes', () => {
    expect(encodeHoloUvCompletionPayloadV1(7, null)).toEqual(bytes('0000000700000000'))
    expect(encodeHoloUvCompletionPayloadV1(null, 'SIGTERM')).toEqual(
      bytes('ffffffff000000075349475445524d')
    )
    expect(decodeHoloUvCompletionPayloadV1(bytes('0000000700000000'))).toEqual({ code: 7, signal: null })
    expect(decodeHoloUvCompletionPayloadV1(bytes('ffffffff000000075349475445524d'))).toEqual({
      code: null,
      signal: 'SIGTERM'
    })
    expect(encodeHoloUvSpawnedPayloadV1(901)).toEqual(bytes('00000385'))
    expect(decodeHoloUvSpawnedPayloadV1(bytes('00000385'), 41)).toEqual({ linuxPid: 901, processId: 41 })
    expect(encodeHoloUvSignalPayloadV1('SIGKILL')).toEqual(bytes('000000075349474b494c4c'))
    expect(Object.assign({}, decodeHoloUvErrorPayloadV1(bytes('0000000c737061776e2e6661696c6564')))).toEqual({
      code: 'spawn.failed'
    })
  })

  it('encodes a canonical spawn payload accepted by holo_parse_spawn', () => {
    expect(encodeHoloUvSpawnPayloadV1({
      args: ['hello'],
      cwd: '/workspace',
      env: { LANG: 'C', A: '1' },
      executable: { kind: 'guestPath', path: '/bin/echo' },
      executableId: 'echo',
      processResourceId: 'process-1',
      signal: new AbortController().signal,
      stdio: ['pipe', 'pipe', 'ignore']
    })).toEqual(bytes([
      '01030000',
      '000000092f62696e2f6563686f',
      '0000000a2f776f726b7370616365',
      '000000046563686f',
      '0000000970726f636573732d31',
      '0001',
      '0002',
      '0000000568656c6c6f',
      '0000000141',
      '0000000131',
      '000000044c414e47',
      '0000000143'
    ].join('')))
  })

  it('encodes sorted, unique environment host mappings', () => {
    expect(encodeHoloUvEnvironmentConfigurationV1({
      execGateTimeoutMs: 30_000,
      hosts: [
        { address: '192.168.87.2', hostname: 'z.example' },
        { address: '192.168.87.1', hostname: 'a.example' }
      ],
      version: 1
    })).toEqual(bytes([
      '0100000200007530',
      '0000000c3139322e3136382e38372e31',
      '00000009612e6578616d706c65',
      '0000000c3139322e3136382e38372e32',
      '000000097a2e6578616d706c65'
    ].join('')))
    expect(() =>
      encodeHoloUvEnvironmentConfigurationV1({
        execGateTimeoutMs: 30_000,
        hosts: [
          { address: '192.168.87.1', hostname: 'same.example' },
          { address: '192.168.87.2', hostname: 'same.example' }
        ],
        version: 1
      })
    ).toThrow(TypeError)
  })

  it('round-trips strict Linux capability requests and JSON terminals', () => {
    const request = { command: ['system', 'read', 'os.arch'], version: 1 } as const
    const success = { json: '{"value":"x64"}', ok: true, version: 1 } as const
    const failure = { error: 'bridge.unavailable', ok: false, version: 1 } as const

    expect(decodeHoloUvCapabilityRequestV1(encodeHoloUvCapabilityRequestV1(request))).toEqual(request)
    expect(decodeHoloUvCapabilityResponseV1(encodeHoloUvCapabilityResponseV1(success))).toEqual(success)
    expect(decodeHoloUvCapabilityResponseV1(encodeHoloUvCapabilityResponseV1(failure))).toEqual(failure)
    expect(() => encodeHoloUvCapabilityRequestV1({ command: ['system', 'bad token'], version: 1 })).toThrow(
      TypeError
    )
    expect(() => encodeHoloUvCapabilityResponseV1({ json: '{', ok: true, version: 1 })).toThrow(TypeError)
  })

  it('rejects noncanonical text, invalid terminals and nonempty empty-only payloads', () => {
    expect(() => decodeHoloUvErrorPayloadV1(bytes('00000002c080'))).toThrow(TypeError)
    expect(() => decodeHoloUvCompletionPayloadV1(bytes('00000000000000075349474c4f574552'))).toThrow(TypeError)
    expect(() => encodeHoloUvCompletionPayloadV1(0, 'term')).toThrow(TypeError)
    expect(() => encodeHoloUvSignalPayloadV1('SIG-too-long')).toThrow(TypeError)
    expect(() => requireEmptyHoloUvPayloadV1(Uint8Array.of(0))).toThrow(TypeError)
  })
})
