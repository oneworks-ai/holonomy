import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { V86_NODE_ACCEPTANCE_FILES_V1, v86AcceptancePhasesV1 } from '../../v86-acceptance-plan.mjs'

describe('v86 acceptance plan', () => {
  it('keeps Node, Android and Guest gate conformance in the aggregate command', () => {
    assert.deepEqual(v86AcceptancePhasesV1('all'), ['node', 'android', 'guest'])
    assert.deepEqual(v86AcceptancePhasesV1('guest'), ['guest'])
    assert.throws(() => v86AcceptancePhasesV1('unknown'), TypeError)
  })

  it('keeps every real Node v86 suite in the production acceptance command', () => {
    assert.deepEqual(V86_NODE_ACCEPTANCE_FILES_V1, [
      'adapters/node/test/capability-process-v86-runtime.test.mjs',
      'adapters/node/test/capability-process-v86-security-runtime.test.mjs'
    ])
  })
})
