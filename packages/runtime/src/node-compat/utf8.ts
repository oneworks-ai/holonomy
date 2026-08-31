const intrinsicCall = Function.prototype.call.bind(Function.prototype.call) as (
  function_: (this: unknown, ...args: unknown[]) => unknown,
  thisArg: unknown,
  ...args: unknown[]
) => unknown
const stringCharCodeAt = String.prototype.charCodeAt

const charCodeAt = (value: string, index: number): number => {
  return intrinsicCall(
    stringCharCodeAt as (this: unknown, ...args: unknown[]) => unknown,
    value,
    index
  ) as number
}

const forEachUtf8CodePoint = (
  value: string,
  visit: (codePoint: number) => void
): void => {
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = charCodeAt(value, index)
    if (codePoint >= 0xD800 && codePoint <= 0xDBFF) {
      const next = charCodeAt(value, index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codePoint = 0x10000 + ((codePoint - 0xD800) << 10) + next - 0xDC00
        index += 1
      } else {
        codePoint = 0xFFFD
      }
    } else if (codePoint >= 0xDC00 && codePoint <= 0xDFFF) {
      codePoint = 0xFFFD
    }
    visit(codePoint)
  }
}

export const utf8ByteLength = (value: string): number => {
  let length = 0
  forEachUtf8CodePoint(value, codePoint => {
    length += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4
  })
  return length
}

export const encodeUtf8 = (value: string): Uint8Array => {
  const bytes: number[] = []
  forEachUtf8CodePoint(value, codePoint => {
    if (codePoint <= 0x7F) {
      bytes.push(codePoint)
    } else if (codePoint <= 0x7FF) {
      bytes.push(0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F))
    } else if (codePoint <= 0xFFFF) {
      bytes.push(
        0xE0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3F),
        0x80 | (codePoint & 0x3F)
      )
    } else {
      bytes.push(
        0xF0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3F),
        0x80 | ((codePoint >> 6) & 0x3F),
        0x80 | (codePoint & 0x3F)
      )
    }
  })
  return Uint8Array.from(bytes)
}

interface Utf8Sequence {
  codePointMask: number
  secondMaximum: number
  secondMinimum: number
  width: number
}

const sequenceForLead = (lead: number): Utf8Sequence | undefined => {
  if (lead >= 0xC2 && lead <= 0xDF) {
    return { codePointMask: 0x1F, secondMaximum: 0xBF, secondMinimum: 0x80, width: 2 }
  }
  if (lead >= 0xE0 && lead <= 0xEF) {
    return {
      codePointMask: 0x0F,
      secondMaximum: lead === 0xED ? 0x9F : 0xBF,
      secondMinimum: lead === 0xE0 ? 0xA0 : 0x80,
      width: 3
    }
  }
  if (lead >= 0xF0 && lead <= 0xF4) {
    return {
      codePointMask: 0x07,
      secondMaximum: lead === 0xF4 ? 0x8F : 0xBF,
      secondMinimum: lead === 0xF0 ? 0x90 : 0x80,
      width: 4
    }
  }
  return undefined
}

export const decodeUtf8 = (bytes: Uint8Array): string => {
  let result = ''
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index]!
    if (lead <= 0x7F) {
      result += String.fromCodePoint(lead)
      index += 1
      continue
    }
    const sequence = sequenceForLead(lead)
    if (!sequence) {
      result += '\uFFFD'
      index += 1
      continue
    }
    let codePoint = lead & sequence.codePointMask
    let consumed = 1
    let valid = true
    for (let offset = 1; offset < sequence.width; offset += 1) {
      const byte = bytes[index + offset]
      if (byte === undefined) {
        consumed = offset
        valid = false
        break
      }
      const minimum = offset === 1 ? sequence.secondMinimum : 0x80
      const maximum = offset === 1 ? sequence.secondMaximum : 0xBF
      if (byte < minimum || byte > maximum) {
        consumed = offset === 1 ? 1 : offset
        valid = false
        break
      }
      codePoint = (codePoint << 6) | (byte & 0x3F)
      consumed = offset + 1
    }
    result += valid ? String.fromCodePoint(codePoint) : '\uFFFD'
    index += consumed
  }
  return result
}
