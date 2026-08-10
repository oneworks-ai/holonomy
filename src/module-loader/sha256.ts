const ROUND_CONSTANTS = new Uint32Array([
  0x428A2F98,
  0x71374491,
  0xB5C0FBCF,
  0xE9B5DBA5,
  0x3956C25B,
  0x59F111F1,
  0x923F82A4,
  0xAB1C5ED5,
  0xD807AA98,
  0x12835B01,
  0x243185BE,
  0x550C7DC3,
  0x72BE5D74,
  0x80DEB1FE,
  0x9BDC06A7,
  0xC19BF174,
  0xE49B69C1,
  0xEFBE4786,
  0x0FC19DC6,
  0x240CA1CC,
  0x2DE92C6F,
  0x4A7484AA,
  0x5CB0A9DC,
  0x76F988DA,
  0x983E5152,
  0xA831C66D,
  0xB00327C8,
  0xBF597FC7,
  0xC6E00BF3,
  0xD5A79147,
  0x06CA6351,
  0x14292967,
  0x27B70A85,
  0x2E1B2138,
  0x4D2C6DFC,
  0x53380D13,
  0x650A7354,
  0x766A0ABB,
  0x81C2C92E,
  0x92722C85,
  0xA2BFE8A1,
  0xA81A664B,
  0xC24B8B70,
  0xC76C51A3,
  0xD192E819,
  0xD6990624,
  0xF40E3585,
  0x106AA070,
  0x19A4C116,
  0x1E376C08,
  0x2748774C,
  0x34B0BCB5,
  0x391C0CB3,
  0x4ED8AA4A,
  0x5B9CCA4F,
  0x682E6FF3,
  0x748F82EE,
  0x78A5636F,
  0x84C87814,
  0x8CC70208,
  0x90BEFFFA,
  0xA4506CEB,
  0xBEF9A3F7,
  0xC67178F2
])

const rotateRight = (value: number, count: number) => (
  (value >>> count) | (value << (32 - count))
)

export const sha256Hex = (input: Uint8Array) => {
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.byteLength] = 0x80

  const bitLength = input.byteLength * 8
  const paddedView = new DataView(padded.buffer)
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000))
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0)

  const state = new Uint32Array([
    0x6A09E667,
    0xBB67AE85,
    0x3C6EF372,
    0xA54FF53A,
    0x510E527F,
    0x9B05688C,
    0x1F83D9AB,
    0x5BE0CD19
  ])
  const words = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0
      const word2 = words[index - 2] ?? 0
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0
    }

    let a = state[0] ?? 0
    let b = state[1] ?? 0
    let c = state[2] ?? 0
    let d = state[3] ?? 0
    let e = state[4] ?? 0
    let f = state[5] ?? 0
    let g = state[6] ?? 0
    let h = state[7] ?? 0

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temporary1 = (h + sum1 + choice + (ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }

    state[0] = ((state[0] ?? 0) + a) >>> 0
    state[1] = ((state[1] ?? 0) + b) >>> 0
    state[2] = ((state[2] ?? 0) + c) >>> 0
    state[3] = ((state[3] ?? 0) + d) >>> 0
    state[4] = ((state[4] ?? 0) + e) >>> 0
    state[5] = ((state[5] ?? 0) + f) >>> 0
    state[6] = ((state[6] ?? 0) + g) >>> 0
    state[7] = ((state[7] ?? 0) + h) >>> 0
  }

  return [...state].map(value => value.toString(16).padStart(8, '0')).join('')
}
