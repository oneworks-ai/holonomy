import { CapabilityInvocationError } from '../../../../packages/runtime/src/kernel/errors.ts'
import { utf8ByteLength } from '../../../../packages/runtime/src/kernel/validation.ts'
import { sha256Hex } from '../../../../packages/runtime/src/module-loader/sha256.ts'
import { encodeUtf8 } from '../../../../packages/runtime/src/node-compat/encoding.ts'

import { decodeDarwinProcessBytesV1 } from './process-darwin-command.mjs'
import { describeNativeProcessOutputV1 } from './process-v86-command.mjs'

const MAX_STDIN_BYTES = 16 * 1024 * 1024
const invalid = () => {
  throw new TypeError('Invalid private native Darwin Process input')
}

/** Translates private Darwin commands into the existing shared ProcessHostPortV1. */
export class NativeDarwinProcessHostPortV1 {
  #backend

  constructor(backend) {
    this.#backend = backend
    this.descriptor = backend.descriptor
  }

  byteLengthUtf8(value) {
    return utf8ByteLength(value)
  }
  decodeInput(value) {
    if (typeof value === 'string') {
      if (utf8ByteLength(value) > MAX_STDIN_BYTES) {
        throw new CapabilityInvocationError('resource.byte_limit', 'process.stdin.write')
      }
      return encodeUtf8(value)
    }
    if (
      value == null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      Object.keys(value).some(key => !['base64', 'byteLength', 'sha256'].includes(key)) ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 ||
      typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(value.sha256)
    ) return invalid()
    if (typeof value.base64 === 'string' && value.base64.length > Math.ceil(MAX_STDIN_BYTES / 3) * 4) {
      throw new CapabilityInvocationError('resource.byte_limit', 'process.stdin.write')
    }
    const bytes = decodeDarwinProcessBytesV1(value.base64, MAX_STDIN_BYTES)
    if (bytes.byteLength !== value.byteLength || sha256Hex(bytes) !== value.sha256) return invalid()
    return bytes
  }
  describeOutput(bytes) {
    return describeNativeProcessOutputV1(bytes)
  }
  prepareLaunch(input) {
    return this.#backend.prepareLaunch(input)
  }
  spawn(launch, options, sink) {
    return this.#backend.spawn(launch, options, sink)
  }
  spawnSync(launch, options) {
    return this.#backend.spawnSync(launch, options)
  }
  poll() {
    this.#backend.poll()
  }
  closeGeneration(generation) {
    return this.#backend.closeGeneration(generation)
  }
}
