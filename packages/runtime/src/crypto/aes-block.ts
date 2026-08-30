const multiplyByte = (left: number, right: number): number => {
  let a = left
  let b = right
  let result = 0
  for (let index = 0; index < 8; index += 1) {
    if ((b & 1) !== 0) result ^= a
    const highBit = a & 0x80
    a = (a << 1) & 0xFF
    if (highBit !== 0) a ^= 0x1B
    b >>>= 1
  }
  return result
}

const rotateByte = (value: number, bits: number): number => ((value << bits) | (value >>> (8 - bits))) & 0xFF

const createSBox = (): Uint8Array => {
  const sbox = new Uint8Array(256)
  for (let value = 0; value < 256; value += 1) {
    let inverse = 0
    if (value !== 0) {
      inverse = 1
      let base = value
      let exponent = 254
      while (exponent > 0) {
        if ((exponent & 1) !== 0) inverse = multiplyByte(inverse, base)
        base = multiplyByte(base, base)
        exponent >>>= 1
      }
    }
    sbox[value] = inverse ^
      rotateByte(inverse, 1) ^
      rotateByte(inverse, 2) ^
      rotateByte(inverse, 3) ^
      rotateByte(inverse, 4) ^
      0x63
  }
  return sbox
}

const AES_SBOX = createSBox()

const readWord = (bytes: Uint8Array, offset: number): number =>
  (
    (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!
  ) >>> 0

const rotateWord = (word: number): number => ((word << 8) | (word >>> 24)) >>> 0

const substituteWord = (word: number): number =>
  (
    (AES_SBOX[word >>> 24]! << 24) |
    (AES_SBOX[(word >>> 16) & 0xFF]! << 16) |
    (AES_SBOX[(word >>> 8) & 0xFF]! << 8) |
    AES_SBOX[word & 0xFF]!
  ) >>> 0

export const expandAes256Key = (key: Uint8Array): Uint32Array => {
  const words = new Uint32Array(60)
  for (let index = 0; index < 8; index += 1) {
    words[index] = readWord(key, index * 4)
  }
  let roundConstant = 1
  for (let index = 8; index < 60; index += 1) {
    let temporary = words[index - 1]!
    if (index % 8 === 0) {
      temporary = substituteWord(rotateWord(temporary)) ^ (roundConstant << 24)
      roundConstant = multiplyByte(roundConstant, 2)
    } else if (index % 8 === 4) {
      temporary = substituteWord(temporary)
    }
    words[index] = (words[index - 8]! ^ temporary) >>> 0
  }
  return words
}

const addRoundKey = (state: Uint8Array, words: Uint32Array, round: number): void => {
  for (let column = 0; column < 4; column += 1) {
    const word = words[round * 4 + column]!
    const offset = column * 4
    state[offset] ^= word >>> 24
    state[offset + 1] ^= word >>> 16
    state[offset + 2] ^= word >>> 8
    state[offset + 3] ^= word
  }
}

const substituteBytes = (state: Uint8Array): void => {
  for (let index = 0; index < 16; index += 1) {
    state[index] = AES_SBOX[state[index]!]!
  }
}

const shiftRows = (state: Uint8Array): void => {
  const copy = new Uint8Array(16)
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      copy[row + column * 4] = state[row + ((column + row) % 4) * 4]!
    }
  }
  for (let index = 0; index < 16; index += 1) {
    state[index] = copy[index]!
  }
}

const mixColumns = (state: Uint8Array): void => {
  for (let column = 0; column < 4; column += 1) {
    const offset = column * 4
    const first = state[offset]!
    const second = state[offset + 1]!
    const third = state[offset + 2]!
    const fourth = state[offset + 3]!
    state[offset] = multiplyByte(first, 2) ^ multiplyByte(second, 3) ^ third ^ fourth
    state[offset + 1] = first ^ multiplyByte(second, 2) ^ multiplyByte(third, 3) ^ fourth
    state[offset + 2] = first ^ second ^ multiplyByte(third, 2) ^ multiplyByte(fourth, 3)
    state[offset + 3] = multiplyByte(first, 3) ^ second ^ third ^ multiplyByte(fourth, 2)
  }
}

export const encryptBlock = (schedule: Uint32Array, input: Uint8Array): Uint8Array => {
  const state = new Uint8Array(16)
  for (let index = 0; index < 16; index += 1) state[index] = input[index]!
  addRoundKey(state, schedule, 0)
  for (let round = 1; round < 14; round += 1) {
    substituteBytes(state)
    shiftRows(state)
    mixColumns(state)
    addRoundKey(state, schedule, round)
  }
  substituteBytes(state)
  shiftRows(state)
  addRoundKey(state, schedule, 14)
  return state
}
