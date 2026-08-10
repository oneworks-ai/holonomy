export const rotateLeft = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) >>> 0

export const rotateRight = (value: number, bits: number): number => ((value >>> bits) | (value << (32 - bits))) >>> 0

export const readWord = (block: Uint8Array, offset: number): number =>
  ((block[offset]! << 24) | (block[offset + 1]! << 16) | (block[offset + 2]! << 8) | block[offset + 3]!) >>> 0

export const writeWord = (output: Uint8Array, offset: number, value: number): void => {
  output[offset] = value >>> 24
  output[offset + 1] = value >>> 16
  output[offset + 2] = value >>> 8
  output[offset + 3] = value
}
