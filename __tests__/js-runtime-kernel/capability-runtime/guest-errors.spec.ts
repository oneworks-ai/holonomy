import { describe, expect, it } from 'vitest'

import { CapabilityInvocationError } from '../../../src/capability-runtime/errors.js'
import { translateCapabilityErrorV1 } from '../../../src/capability-runtime/guest-errors.js'

describe('child-process error projection', () => {
  it('uses the stdin-write projection for input quota failures', () => {
    const error = translateCapabilityErrorV1(
      new CapabilityInvocationError('resource.byte_limit', 'process.stdin.write'),
      'childProcess'
    )
    expect(error.code).toBe('EFBIG')
  })

  it('uses the captured-output projection for sync process output limits', () => {
    const error = translateCapabilityErrorV1(
      new CapabilityInvocationError('resource.byte_limit', 'process.program.spawn'),
      'childProcess'
    )
    expect(error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  })
})
