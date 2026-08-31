import { sha256Hex } from '@holonomyjs/runtime/module-loader/sha256'
import { encodeUtf8 } from '@holonomyjs/runtime/node-compat/utf8'
import type { NetworkHeaderViewV1, NetworkQueryViewV1 } from './network-invocation-types.js'

const uint32 = (value: number): Uint8Array => {
  const output = new Uint8Array(4)
  new DataView(output.buffer).setUint32(0, value)
  return output
}

const field = (value: string): readonly Uint8Array[] => {
  const bytes = encodeUtf8(value)
  return [uint32(bytes.byteLength), bytes]
}

export const networkViewDigestV1 = (
  domain: 'header' | 'query',
  entries: readonly (NetworkHeaderViewV1 | NetworkQueryViewV1)[]
): string => {
  const parts: Uint8Array[] = [uint32(1), ...field(domain), uint32(entries.length)]
  for (const entry of entries) {
    parts.push(uint32(entry.index))
    parts.push(...field('name' in entry ? entry.name : entry.key))
    parts.push(...field(entry.visibility))
    parts.push(...field(entry.visibility === 'visible' ? entry.value : ''))
  }
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return sha256Hex(bytes)
}

export const networkHeaderViewDigestV1 = (entries: readonly NetworkHeaderViewV1[]): string =>
  networkViewDigestV1('header', entries)

export const networkQueryViewDigestV1 = (entries: readonly NetworkQueryViewV1[]): string =>
  networkViewDigestV1('query', entries)
