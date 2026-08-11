import {
  appendTestValue,
  createTestRecord,
  defineTestProperties,
  defineTestProperty,
  freezeTestValue
} from './intrinsics.js'
import type {
  DescribeRegistration,
  HolonomyTestPlatform,
  HookCallback,
  TestCallback,
  TestRegistration
} from './types.js'

export interface RegisteredCase {
  readonly callback?: TestCallback
  readonly name: string
  readonly platform?: HolonomyTestPlatform
  readonly skipped: boolean
}

export interface RegisteredSuite {
  readonly after: HookCallback[]
  readonly afterEach: HookCallback[]
  readonly before: HookCallback[]
  readonly beforeEach: HookCallback[]
  readonly children: Array<RegisteredCase | RegisteredSuite>
  readonly name: string
  readonly parent?: RegisteredSuite
  readonly platform?: HolonomyTestPlatform
  readonly skipped: boolean
}

const PLATFORMS = ['android', 'desktop', 'ios', 'node', 'web'] as const

export const createTestRegistry = () => {
  const root: RegisteredSuite = {
    after: [],
    afterEach: [],
    before: [],
    beforeEach: [],
    children: [],
    name: '',
    skipped: false
  }
  let current = root

  const inheritedPlatform = () => {
    for (let suite: RegisteredSuite | undefined = current; suite != null; suite = suite.parent) {
      if (suite.platform != null) return suite.platform
    }
    return undefined
  }

  const requireCompatiblePlatform = (platform: HolonomyTestPlatform | undefined) => {
    const parentPlatform = inheritedPlatform()
    if (platform != null && parentPlatform != null && platform !== parentPlatform) {
      throw new TypeError('Nested test platform must match its parent suite')
    }
  }

  const registerSuite = (
    name: string,
    callback: (() => void) | undefined,
    skipped: boolean,
    platform?: HolonomyTestPlatform
  ) => {
    if (typeof name !== 'string' || name === '') throw new TypeError('Test suite name must not be empty')
    requireCompatiblePlatform(platform)
    const suite: RegisteredSuite = {
      after: [],
      afterEach: [],
      before: [],
      beforeEach: [],
      children: [],
      name,
      parent: current,
      platform,
      skipped
    }
    appendTestValue(current.children, suite)
    if (callback == null || skipped) return
    const previous = current
    current = suite
    try {
      callback()
    } finally {
      current = previous
    }
  }

  const registerCase = (
    name: string,
    callback: TestCallback | undefined,
    skipped: boolean,
    platform?: HolonomyTestPlatform
  ) => {
    if (typeof name !== 'string' || name === '') throw new TypeError('Test name must not be empty')
    if (!skipped && typeof callback !== 'function') throw new TypeError('Test callback must be a function')
    requireCompatiblePlatform(platform)
    appendTestValue(current.children, { callback, name, platform, skipped })
  }

  const platformMethods = <Callback>(
    register: (platform: HolonomyTestPlatform, name: string, callback: Callback) => void
  ) => {
    const methods = createTestRecord() as Record<HolonomyTestPlatform, (name: string, callback: Callback) => void>
    for (let index = 0; index < PLATFORMS.length; index += 1) {
      const platform = PLATFORMS[index]!
      defineTestProperty(methods, platform, {
        enumerable: true,
        value: (name: string, callback: Callback) => register(platform, name, callback)
      })
    }
    return freezeTestValue(methods)
  }

  const describe =
    ((name: string, callback: () => void) => registerSuite(name, callback, false)) as DescribeRegistration
  defineTestProperties(describe, {
    holonomy: {
      value: platformMethods<() => void>((platform, name, callback) => registerSuite(name, callback, false, platform))
    },
    skip: { value: (name: string, callback?: () => void) => registerSuite(name, callback, true) }
  })

  const it = ((name: string, callback: TestCallback) => registerCase(name, callback, false)) as TestRegistration
  defineTestProperties(it, {
    holonomy: {
      value: platformMethods<TestCallback>((platform, name, callback) => registerCase(name, callback, false, platform))
    },
    skip: { value: (name: string, callback?: TestCallback) => registerCase(name, callback, true) }
  })

  return freezeTestValue({
    after: (callback: HookCallback) => appendTestValue(current.after, callback),
    afterEach: (callback: HookCallback) => appendTestValue(current.afterEach, callback),
    before: (callback: HookCallback) => appendTestValue(current.before, callback),
    beforeEach: (callback: HookCallback) => appendTestValue(current.beforeEach, callback),
    describe: freezeTestValue(describe),
    it: freezeTestValue(it),
    root,
    test: freezeTestValue(it)
  })
}
