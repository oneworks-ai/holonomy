import { createAssertStrictModule } from './assert-strict.js'
import { freezeTestValue } from './intrinsics.js'
import { createTestRegistry } from './test-registry.js'
import { runRegisteredTests } from './test-runner.js'

import type { HolonomyTestPlatform } from './types.js'

export const createNodeTestSyntheticModules = (platform: HolonomyTestPlatform) => {
  const registry = createTestRegistry()
  const testModule = freezeTestValue({
    after: registry.after,
    afterEach: registry.afterEach,
    before: registry.before,
    beforeEach: registry.beforeEach,
    default: registry.test,
    describe: registry.describe,
    it: registry.it,
    run: () => runRegisteredTests(registry.root, platform),
    test: registry.test
  })
  return freezeTestValue({
    'node:assert/strict': createAssertStrictModule(),
    'node:test': testModule
  })
}
