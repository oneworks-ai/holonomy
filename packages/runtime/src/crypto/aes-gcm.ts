import { encryptBlock, expandAes256Key } from './aes-block.js'
import { bigIntToBlock, blockToBigInt, incrementCounter, multiplyGalois, writeUint64Bits } from './gcm-primitives.js'
import { freeze, runtimeArrayClear, runtimeArrayPush } from './intrinsics.js'

export { encryptBlock, expandAes256Key } from './aes-block.js'
export { bigIntToBlock, blockToBigInt, incrementCounter, multiplyGalois, writeUint64Bits } from './gcm-primitives.js'

export interface AesGcmFinalResult {
  readonly authenticated?: boolean
  readonly authTag?: Uint8Array
  readonly output: Uint8Array
}

export class Aes256Gcm {
  readonly #aadPending: number[] = []
  readonly #cipherPending: number[] = []
  readonly #counter = new Uint8Array(16)
  readonly #decrypt: boolean
  readonly #hashSubkey: bigint
  readonly #schedule: Uint32Array
  readonly #tagMask: Uint8Array
  #aadBytes = 0
  #aadFinished = false
  #authTag: Uint8Array | undefined
  #cipherBytes = 0
  #disposed = false
  #finalized = false
  #ghash = 0n
  #streamBlock: Uint8Array = new Uint8Array(16)
  #streamOffset = 16

  constructor(key: Uint8Array, iv: Uint8Array, decrypt: boolean) {
    this.#decrypt = decrypt
    this.#schedule = expandAes256Key(key)
    const zero = new Uint8Array(16)
    this.#hashSubkey = blockToBigInt(encryptBlock(this.#schedule, zero))
    for (let index = 0; index < 12; index += 1) {
      this.#counter[index] = iv[index]!
    }
    this.#counter[15] = 1
    this.#tagMask = encryptBlock(this.#schedule, this.#counter)
  }

  setAAD(aad: Uint8Array): void {
    this.#assertActive()
    if (this.#aadFinished) throw new Error('aad is finalized')
    this.#aadBytes += aad.byteLength
    this.#appendGhashBytes(this.#aadPending, aad)
  }

  setAuthTag(authTag: Uint8Array): void {
    this.#assertActive()
    if (!this.#decrypt || this.#authTag !== undefined) {
      throw new Error('auth tag state is invalid')
    }
    const snapshot = new Uint8Array(authTag.byteLength)
    for (let index = 0; index < authTag.byteLength; index += 1) {
      snapshot[index] = authTag[index]!
    }
    this.#authTag = snapshot
  }

  update(input: Uint8Array): Uint8Array {
    this.#assertActive()
    this.#finishAAD()
    const output = new Uint8Array(input.byteLength)
    for (let index = 0; index < input.byteLength; index += 1) {
      if (this.#streamOffset === 16) {
        incrementCounter(this.#counter)
        this.#streamBlock = encryptBlock(this.#schedule, this.#counter)
        this.#streamOffset = 0
      }
      output[index] = input[index]! ^ this.#streamBlock[this.#streamOffset]!
      this.#streamOffset += 1
    }
    this.#cipherBytes += input.byteLength
    this.#appendGhashBytes(this.#cipherPending, this.#decrypt ? input : output)
    return output
  }

  final(): AesGcmFinalResult {
    this.#assertActive()
    this.#finalized = true
    this.#finishAAD()
    this.#finishPending(this.#cipherPending)
    const lengths = new Uint8Array(16)
    writeUint64Bits(lengths, 0, this.#aadBytes)
    writeUint64Bits(lengths, 8, this.#cipherBytes)
    this.#processGhashBlock(lengths)
    const hash = bigIntToBlock(this.#ghash)
    const tag = new Uint8Array(16)
    for (let index = 0; index < 16; index += 1) {
      tag[index] = hash[index]! ^ this.#tagMask[index]!
    }
    if (this.#decrypt) {
      const supplied = this.#authTag
      let difference = supplied === undefined || supplied.byteLength !== 16 ? 1 : 0
      for (let index = 0; index < 16; index += 1) {
        difference |= tag[index]! ^ (supplied?.[index] ?? 0)
      }
      return freeze({
        authenticated: difference === 0,
        output: new Uint8Array(0)
      })
    }
    return freeze({ authTag: tag, output: new Uint8Array(0) })
  }

  dispose(): void {
    if (this.#disposed) return
    for (let index = 0; index < this.#schedule.length; index += 1) {
      this.#schedule[index] = 0
    }
    for (let index = 0; index < this.#counter.length; index += 1) {
      this.#counter[index] = 0
      this.#streamBlock[index] = 0
      this.#tagMask[index] = 0
      if (this.#authTag !== undefined) this.#authTag[index] = 0
    }
    runtimeArrayClear(this.#aadPending)
    runtimeArrayClear(this.#cipherPending)
    this.#ghash = 0n
    this.#disposed = true
  }

  #assertActive(): void {
    if (this.#disposed || this.#finalized) {
      throw new Error('cipher is unavailable')
    }
  }

  #appendGhashBytes(pending: number[], input: Uint8Array): void {
    for (let index = 0; index < input.byteLength; index += 1) {
      runtimeArrayPush(pending, input[index]!)
      if (pending.length === 16) {
        const block = new Uint8Array(16)
        for (let byte = 0; byte < 16; byte += 1) block[byte] = pending[byte]!
        runtimeArrayClear(pending)
        this.#processGhashBlock(block)
      }
    }
  }

  #finishAAD(): void {
    if (this.#aadFinished) return
    this.#finishPending(this.#aadPending)
    this.#aadFinished = true
  }

  #finishPending(pending: number[]): void {
    if (pending.length === 0) return
    const block = new Uint8Array(16)
    for (let index = 0; index < pending.length; index += 1) {
      block[index] = pending[index]!
    }
    runtimeArrayClear(pending)
    this.#processGhashBlock(block)
  }

  #processGhashBlock(block: Uint8Array): void {
    this.#ghash = multiplyGalois(this.#ghash ^ blockToBigInt(block), this.#hashSubkey)
  }
}
