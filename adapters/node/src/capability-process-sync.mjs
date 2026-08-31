import { Buffer } from 'node:buffer'

import { CapabilityInvocationError } from '../../../dist/capability-runtime/index.js'

import { binary, nodeError } from './capability-process-support.mjs'

export const spawnNodeProcessSyncV1 = ({ backend, context, env, launch, options, policy, resources, stdio }) => {
  const result = backend.spawnSync(launch, {
    cwd: launch.cwd,
    encoding: options.encoding === 'utf8' ? 'utf8' : 'buffer',
    env,
    killSignal: 'SIGKILL',
    maxBuffer: Math.min(
      options.maxBufferBytes ?? policy.limits.maxStdoutBytes,
      policy.limits.maxStdoutBytes,
      policy.limits.maxStderrBytes
    ),
    shell: false,
    stdio,
    timeout: Math.min(
      options.timeoutMs ?? policy.limits.maxExecutionTimeMs,
      policy.limits.maxExecutionTimeMs
    )
  })
  const output = stream =>
    options.encoding === 'utf8'
      ? stream ?? ''
      : binary(stream ?? Buffer.alloc(0))
  const failure = () => {
    if (result.error?.code === 'ENOBUFS') {
      throw new CapabilityInvocationError('resource.byte_limit', context.operation)
    }
    if (result.error?.code === 'ETIMEDOUT') {
      throw new CapabilityInvocationError('provider.timeout', context.operation)
    }
    throw new CapabilityInvocationError('provider.unavailable', context.operation)
  }
  if (context.member === 'execFileSync' || context.member === 'execSync') {
    if (result.error != null || result.status !== 0) failure()
    return output(result.stdout)
  }
  return {
    ...(result.error == null
      ? {}
      : {
        error: nodeError(
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
