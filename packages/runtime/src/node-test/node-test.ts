import { createAssertStrictModule } from './assert-strict.js'
import { freezeTestValue } from './intrinsics.js'
import { createTestRegistry } from './test-registry.js'

import type { HolonomyTestPlatform } from './types.js'

export const createNodeTestSyntheticModules = (
  platform: HolonomyTestPlatform,
  promiseBrand?: (value: unknown) => boolean
) => {
  const registry = createTestRegistry(platform)
  const testModule = freezeTestValue({
    after: registry.after,
    afterEach: registry.afterEach,
    before: registry.before,
    beforeEach: registry.beforeEach,
    default: registry.test,
    describe: registry.describe,
    it: registry.it,
    run: registry.run,
    test: registry.test
  })
  return freezeTestValue({
    'node:assert/strict': createAssertStrictModule(promiseBrand),
    'node:test': testModule
  })
}
