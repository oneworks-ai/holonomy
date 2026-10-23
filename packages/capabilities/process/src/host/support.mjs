// The Host supplies byte conversion. This leaf owns policy and event semantics,
// but neither Node Buffer nor a platform crypto implementation.
export const processError = code =>
  Object.freeze({
    code,
    message: `${code}: controlled child process failed`,
    name: 'Error',
    retryable: false
  })

export const processSignal = (value, CapabilityInvocationError) => {
  const signal = value ?? 'SIGTERM'
  if (!['SIGINT', 'SIGKILL', 'SIGTERM'].includes(signal)) {
    throw new CapabilityInvocationError('argument.invalid', 'process.signal.send')
  }
  return signal
}

export const exactEnvironment = (policy, value, port, CapabilityInvocationError) => {
  const source = value ?? {}
  const output = Object.create(null)
  for (const [name, content] of Object.entries(source)) {
    if (
      !policy.allowedNames.includes(name) || typeof content !== 'string' ||
      port.byteLengthUtf8(content) > policy.maxValueBytes
    ) throw new CapabilityInvocationError('policy.denied', 'process.program.spawn')
    output[name] = content
  }
  return output
}

export const processInputData = (value, port, CapabilityInvocationError) => {
  if (typeof value !== 'string' && value?.base64 == null) {
    throw new CapabilityInvocationError('argument.invalid', 'process.stdin.write')
  }
  return port.decodeInput(value)
}
