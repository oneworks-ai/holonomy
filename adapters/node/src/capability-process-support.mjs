import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

export const nodeError = code =>
  Object.freeze({
    code,
    message: `${code}: controlled child process failed`,
    name: 'Error',
    retryable: false
  })

export const binary = bytes =>
  Object.freeze({
    base64: Buffer.from(bytes).toString('base64'),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  })

export const processSignal = value => {
  const signal = value ?? 'SIGTERM'
  if (!['SIGINT', 'SIGKILL', 'SIGTERM'].includes(signal)) {
    throw new CapabilityInvocationError('argument.invalid', 'process.signal.send')
  }
  return signal
}

export const exactEnvironment = (policy, value) => {
  const source = value ?? {}
  const output = Object.create(null)
  for (const [name, content] of Object.entries(source)) {
    if (
      !policy.allowedNames.includes(name) || typeof content !== 'string' ||
      Buffer.byteLength(content) > policy.maxValueBytes
    ) throw new CapabilityInvocationError('policy.denied', 'process.program.spawn')
    output[name] = content
  }
  return output
}

export const processInputData = value => {
  if (typeof value === 'string') return Buffer.from(value)
  if (value?.base64 == null) {
    throw new CapabilityInvocationError('argument.invalid', 'process.stdin.write')
  }
  return Buffer.from(value.base64, 'base64')
}
