const GCM_REDUCTION = 0xE1000000000000000000000000000000n

export const blockToBigInt = (block: Uint8Array): bigint => {
  let value = 0n
  for (let index = 0; index < 16; index += 1) {
    value = (value << 8n) | BigInt(block[index]!)
  }
  return value
}

export const bigIntToBlock = (value: bigint): Uint8Array => {
  const block = new Uint8Array(16)
  let remaining = value
  for (let index = 15; index >= 0; index -= 1) {
    block[index] = Number(remaining & 0xFFn)
    remaining >>= 8n
  }
  return block
}

export const multiplyGalois = (left: bigint, right: bigint): bigint => {
  let result = 0n
  let value = right
  for (let bit = 0; bit < 128; bit += 1) {
    if ((left & (1n << BigInt(127 - bit))) !== 0n) result ^= value
    value = (value & 1n) === 0n
      ? value >> 1n
      : (value >> 1n) ^ GCM_REDUCTION
  }
  return result
}

export const incrementCounter = (counter: Uint8Array): void => {
  for (let index = 15; index >= 12; index -= 1) {
    counter[index] = (counter[index]! + 1) & 0xFF
    if (counter[index] !== 0) break
  }
}

export const writeUint64Bits = (block: Uint8Array, offset: number, byteLength: number): void => {
  const bitLength = byteLength * 8
  const high = Math.floor(bitLength / 0x1_0000_0000)
  const low = bitLength >>> 0
  block[offset] = high >>> 24
  block[offset + 1] = high >>> 16
  block[offset + 2] = high >>> 8
  block[offset + 3] = high
  block[offset + 4] = low >>> 24
  block[offset + 5] = low >>> 16
  block[offset + 6] = low >>> 8
  block[offset + 7] = low
}
