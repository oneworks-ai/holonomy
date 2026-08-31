import { outOfBounds } from './errors.js'

export interface ArrayBufferViewRange {
  readonly length: number
  readonly offset: number
}

export const resolveArrayBufferViewRange = (
  byteLength: number,
  offsetInput?: number,
  lengthInput?: number
): ArrayBufferViewRange => {
  const rawOffset = offsetInput === undefined || Number.isNaN(offsetInput)
    ? 0
    : offsetInput
  const offset = Math.trunc(rawOffset)
  if (!Number.isFinite(offset) || offset < 0 || rawOffset > byteLength) {
    outOfBounds('Buffer.from ArrayBuffer offset is outside the buffer')
  }
  if (lengthInput === undefined) {
    return { length: byteLength - offset, offset }
  }

  const rawLength = Number.isNaN(lengthInput) || lengthInput <= 0
    ? 0
    : lengthInput
  if (
    !Number.isFinite(rawLength) ||
    rawOffset + rawLength > byteLength
  ) {
    outOfBounds('Buffer.from ArrayBuffer length is outside the buffer')
  }
  return { length: Math.trunc(rawLength), offset }
}
