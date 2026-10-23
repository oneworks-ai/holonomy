import { processError } from './support.mjs'

export const spawnProcessSyncV1 = ({ context, contracts, env, launch, options, policy, port, resources, stdio }) => {
  const result = port.spawnSync(launch, {
    encoding: options.encoding === 'utf8' ? 'utf8' : 'buffer',
    env,
    killSignal: 'SIGKILL',
    maxBuffer: Math.min(
      options.maxBufferBytes ?? policy.limits.maxStdoutBytes,
      policy.limits.maxStdoutBytes,
      policy.limits.maxStderrBytes
    ),
    stdio,
    timeout: Math.min(
      options.timeoutMs ?? policy.limits.maxExecutionTimeMs,
      policy.limits.maxExecutionTimeMs
    )
  })
  const output = stream =>
    options.encoding === 'utf8'
      ? stream ?? ''
      : port.describeOutput(stream ?? new Uint8Array(0))
  const failure = () => {
    if (result.error?.code === 'ENOBUFS') {
      throw new contracts.CapabilityInvocationError('resource.byte_limit', context.operation)
    }
    if (result.error?.code === 'ETIMEDOUT') {
      throw new contracts.CapabilityInvocationError('provider.timeout', context.operation)
    }
    throw new contracts.CapabilityInvocationError('provider.unavailable', context.operation)
  }
  if (context.member === 'execFileSync' || context.member === 'execSync') {
    if (result.error != null || result.status !== 0) failure()
    return output(result.stdout)
  }
  return {
    ...(result.error == null ? {} : {
      error: processError(
        result.error.code === 'ENOBUFS'
          ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          : result.error.code === 'ETIMEDOUT'
          ? 'ETIMEDOUT'
          : 'ERR_OPERATION_FAILED'
      )
    }),
    pid: resources.allocatePublicId(),
    signal: result.signal,
    status: result.status,
    stderr: output(result.stderr),
    stdout: output(result.stdout)
  }
}
