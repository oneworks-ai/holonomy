import { SHA256_CONSTANTS } from './sha-constants.js'
import { readWord, rotateLeft, rotateRight, writeWord } from './sha-words.js'

export class ShaDigest {
  readonly #algorithm: 'sha1' | 'sha256'
  readonly #block = new Uint8Array(64)
  readonly #state: Uint32Array
  #blockLength = 0
  #disposed = false
  #finalized = false
  #totalBytes = 0

  constructor(algorithm: 'sha1' | 'sha256') {
    this.#algorithm = algorithm
    this.#state = algorithm === 'sha1'
      ? new Uint32Array([
        0x67452301,
        0xEFCDAB89,
        0x98BADCFE,
        0x10325476,
        0xC3D2E1F0
      ])
      : new Uint32Array([
        0x6A09E667,
        0xBB67AE85,
        0x3C6EF372,
        0xA54FF53A,
        0x510E527F,
        0x9B05688C,
        0x1F83D9AB,
        0x5BE0CD19
      ])
  }

  update(input: Uint8Array): void {
    if (this.#disposed || this.#finalized) {
      throw new Error('hash is unavailable')
    }
    this.#totalBytes += input.byteLength
    this.#append(input)
  }

  #append(input: Uint8Array): void {
    for (let index = 0; index < input.byteLength; index += 1) {
      this.#block[this.#blockLength] = input[index]!
      this.#blockLength += 1
      if (this.#blockLength === 64) {
        if (this.#algorithm === 'sha1') {
          this.#processSha1()
        } else {
          this.#processSha256()
        }
        this.#blockLength = 0
      }
    }
  }

  digest(): Uint8Array {
    if (this.#disposed || this.#finalized) {
      throw new Error('hash is unavailable')
    }
    this.#finalized = true
    const bitLength = this.#totalBytes * 8
    const paddingLength = (56 - ((this.#totalBytes + 1) % 64) + 64) % 64
    const padding = new Uint8Array(1 + paddingLength + 8)
    padding[0] = 0x80
    const high = Math.floor(bitLength / 0x1_0000_0000)
    const low = bitLength >>> 0
    writeWord(padding, padding.byteLength - 8, high)
    writeWord(padding, padding.byteLength - 4, low)
    this.#append(padding)
    if (this.#blockLength !== 0) {
      throw new Error('invalid hash padding state')
    }
    const output = new Uint8Array(this.#state.length * 4)
    for (let index = 0; index < this.#state.length; index += 1) {
      writeWord(output, index * 4, this.#state[index]!)
    }
    return output
  }

  dispose(): void {
    if (this.#disposed) return
    for (let index = 0; index < this.#block.length; index += 1) {
      this.#block[index] = 0
    }
    for (let index = 0; index < this.#state.length; index += 1) {
      this.#state[index] = 0
    }
    this.#blockLength = 0
    this.#totalBytes = 0
    this.#disposed = true
  }

  #processSha1(): void {
    const words = new Uint32Array(80)
    for (let index = 0; index < 16; index += 1) {
      words[index] = readWord(this.#block, index * 4)
    }
    for (let index = 16; index < 80; index += 1) {
      words[index] = rotateLeft(
        words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!,
        1
      )
    }
    let a = this.#state[0]!
    let b = this.#state[1]!
    let c = this.#state[2]!
    let d = this.#state[3]!
    let e = this.#state[4]!
    for (let index = 0; index < 80; index += 1) {
      let f: number
      let k: number
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5A827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ED9EBA1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8F1BBCDC
      } else {
        f = b ^ c ^ d
        k = 0xCA62C1D6
      }
      const temporary = (rotateLeft(a, 5) + f + e + k + words[index]!) >>> 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = temporary
    }
    this.#state[0] = (this.#state[0]! + a) >>> 0
    this.#state[1] = (this.#state[1]! + b) >>> 0
    this.#state[2] = (this.#state[2]! + c) >>> 0
    this.#state[3] = (this.#state[3]! + d) >>> 0
    this.#state[4] = (this.#state[4]! + e) >>> 0
  }

  #processSha256(): void {
    const words = new Uint32Array(64)
    for (let index = 0; index < 16; index += 1) {
      words[index] = readWord(this.#block, index * 4)
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!
      const word2 = words[index - 2]!
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)
      words[index] = (
        words[index - 16]! + sigma0 + words[index - 7]! + sigma1
      ) >>> 0
    }
    let a = this.#state[0]!
    let b = this.#state[1]!
    let c = this.#state[2]!
    let d = this.#state[3]!
    let e = this.#state[4]!
    let f = this.#state[5]!
    let g = this.#state[6]!
    let h = this.#state[7]!
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temporary1 = (h + sum1 + choose + SHA256_CONSTANTS[index]! + words[index]!) >>> 0
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
    this.#state[0] = (this.#state[0]! + a) >>> 0
    this.#state[1] = (this.#state[1]! + b) >>> 0
    this.#state[2] = (this.#state[2]! + c) >>> 0
    this.#state[3] = (this.#state[3]! + d) >>> 0
    this.#state[4] = (this.#state[4]! + e) >>> 0
    this.#state[5] = (this.#state[5]! + f) >>> 0
    this.#state[6] = (this.#state[6]! + g) >>> 0
    this.#state[7] = (this.#state[7]! + h) >>> 0
  }
}

export { HmacSha256 } from './hmac-sha256.js'
