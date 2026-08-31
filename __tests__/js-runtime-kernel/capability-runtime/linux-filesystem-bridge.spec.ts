import { LinuxFilesystemCapabilityBridgeV1 } from '@holonomyjs/capability-fs'
import { CapabilityInvocationError } from '@holonomyjs/runtime/kernel'
import { describe, expect, it } from 'vitest'

const input = Object.freeze({
  environmentId: 'test:1:v86',
  executableId: 'busybox.sh',
  linuxPid: 41,
  operation: 'lookup' as const,
  path: '/workspace/missing.txt',
  policy: Object.freeze({
    access: 'sandboxed' as const,
    environment: Object.freeze({ allowedNames: Object.freeze([]), maxValueBytes: 1024 }),
    executables: Object.freeze([
      Object.freeze({ argumentBytes: 1024, executableId: 'busybox.sh' })
    ]),
    limits: Object.freeze({
      maxConcurrentProcesses: 1,
      maxExecutionTimeMs: 1000,
      maxOpenPipes: 3,
      maxProcessTreeDepth: 1,
      maxStderrBytes: 1024,
      maxStdinBytes: 1024,
      maxStdoutBytes: 1024,
      maxTotalProcesses: 1,
      maxWritableRootfsBytes: 1024
    }),
    mounts: Object.freeze([
      Object.freeze({
        guestPath: '/workspace',
        rootId: 'workspace',
        rights: Object.freeze(['read' as const, 'write' as const])
      })
    ]),
    network: Object.freeze({ access: 'none' as const }),
    shell: Object.freeze({ access: 'none' as const })
  }),
  processId: 9,
  processResourceId: 'process-9',
  scope: 'processTree' as const
})

describe('linux filesystem capability Bridge v1', () => {
  it('preserves the closed capability code and errno for a missing Host path', async () => {
    const bridge = new LinuxFilesystemCapabilityBridgeV1().bind(async () => {
      throw new CapabilityInvocationError('resource.not_found', 'filesystem.metadata.stat')
    })

    await expect(bridge.dispatch(input)).rejects.toMatchObject({
      code: 'resource.not_found',
      errno: 2
    })
  })
})
