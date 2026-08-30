import { ShaDigest } from './sha.js'

export class HmacSha256 {
  readonly #inner = new ShaDigest('sha256')
  readonly #outerPad = new Uint8Array(64)
  #disposed = false
  #finalized = false

  constructor(key: Uint8Array) {
    let normalizedKey = key
    let hashedKey: Uint8Array | undefined
    if (key.byteLength > 64) {
      const keyHash = new ShaDigest('sha256')
      keyHash.update(key)
      hashedKey = keyHash.digest()
      normalizedKey = hashedKey
      keyHash.dispose()
    }
    const innerPad = new Uint8Array(64)
    for (let index = 0; index < 64; index += 1) {
      const keyByte = normalizedKey[index] ?? 0
      innerPad[index] = keyByte ^ 0x36
      this.#outerPad[index] = keyByte ^ 0x5C
    }
    this.#inner.update(innerPad)
    for (let index = 0; index < innerPad.length; index += 1) innerPad[index] = 0
    if (hashedKey !== undefined) {
      for (let index = 0; index < hashedKey.length; index += 1) hashedKey[index] = 0
    }
  }

  update(input: Uint8Array): void {
    if (this.#disposed || this.#finalized) throw new Error('hmac is unavailable')
    this.#inner.update(input)
  }

  digest(): Uint8Array {
    if (this.#disposed || this.#finalized) throw new Error('hmac is unavailable')
    this.#finalized = true
    const innerDigest = this.#inner.digest()
    const outer = new ShaDigest('sha256')
    outer.update(this.#outerPad)
    outer.update(innerDigest)
    const output = outer.digest()
    outer.dispose()
    for (let index = 0; index < innerDigest.length; index += 1) innerDigest[index] = 0
    return output
  }

  dispose(): void {
    if (this.#disposed) return
    this.#inner.dispose()
    for (let index = 0; index < this.#outerPad.length; index += 1) this.#outerPad[index] = 0
    this.#disposed = true
  }
}
