const invalid = () => {
  throw new TypeError('Invalid v86 UDP packet')
}

const checksum = bytes => {
  let sum = 0
  for (let index = 0; index < bytes.byteLength; index += 2) {
    sum += (bytes[index] << 8) | (bytes[index + 1] ?? 0)
    while (sum > 0xFFFF) sum = (sum & 0xFFFF) + (sum >>> 16)
  }
  return (~sum) & 0xFFFF
}

const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])
const ROUTER = Object.freeze([192, 168, 86, 1])

export const decodeV86UdpDatagramV1 = value => {
  if (!(value instanceof Uint8Array) || value.byteLength < 42) return undefined
  const bytes = Uint8Array.from(value)
  const view = new DataView(bytes.buffer)
  if (view.getUint16(12) !== 0x0800 || bytes[14] !== 0x45 || bytes[23] !== 17) return undefined
  const totalLength = view.getUint16(16)
  const fragment = view.getUint16(20)
  if ((fragment & 0x3FFF) !== 0 || totalLength < 28 || bytes.byteLength < 14 + totalLength) return undefined
  const udpLength = view.getUint16(38)
  if (udpLength < 8 || totalLength !== 20 + udpLength) return undefined
  const sourceAddress = Object.freeze([...bytes.slice(26, 30)])
  const destinationAddress = Object.freeze([...bytes.slice(30, 34)])
  const sourcePort = view.getUint16(34)
  const destinationPort = view.getUint16(36)
  if (sourcePort === 0 || destinationPort === 0) return undefined
  const internal = equal(destinationAddress, ROUTER) && [8, 53, 123].includes(destinationPort) ||
    equal(destinationAddress, [255, 255, 255, 255]) && destinationPort === 67
  return Object.freeze({
    destinationAddress,
    destinationMac: Object.freeze([...bytes.slice(0, 6)]),
    destinationPort,
    internal,
    payload: bytes.slice(42, 34 + udpLength),
    sourceAddress,
    sourceMac: Object.freeze([...bytes.slice(6, 12)]),
    sourcePort
  })
}

export const encodeV86UdpResponseV1 = (request, value) => {
  if (
    request == null || typeof request !== 'object' || !(value instanceof Uint8Array) ||
    value.byteLength > 1472
  ) return invalid()
  const output = new Uint8Array(42 + value.byteLength)
  const view = new DataView(output.buffer)
  output.set(request.sourceMac, 0)
  output.set(request.destinationMac, 6)
  view.setUint16(12, 0x0800)
  output[14] = 0x45
  view.setUint16(16, 28 + value.byteLength)
  view.setUint16(18, 0)
  view.setUint16(20, 0x4000)
  output[22] = 64
  output[23] = 17
  output.set(request.destinationAddress, 26)
  output.set(request.sourceAddress, 30)
  view.setUint16(24, checksum(output.subarray(14, 34)))
  view.setUint16(34, request.destinationPort)
  view.setUint16(36, request.sourcePort)
  view.setUint16(38, 8 + value.byteLength)
  view.setUint16(40, 0)
  output.set(value, 42)
  return output
}
