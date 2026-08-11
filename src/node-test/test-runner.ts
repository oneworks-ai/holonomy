import { appendTestValue, freezeTestValue, maxTestNumber, nowForTest, testString } from './intrinsics.js'
import type { RegisteredCase, RegisteredSuite } from './test-registry.js'
import type { HolonomyTestPlatform, HookCallback, TestCaseResult, TestFailure, TestRunSummary } from './types.js'

const NOW = nowForTest

const failure = (error: unknown): TestFailure => {
  if (error instanceof Error) {
    return freezeTestValue({
      message: error.message,
      name: error.name,
      ...(error.stack == null ? {} : { stack: error.stack })
    })
  }
  return freezeTestValue({ message: testString(error), name: 'Error' })
}

const runHooks = async (hooks: readonly HookCallback[]) => {
  for (let index = 0; index < hooks.length; index += 1) await hooks[index]!()
}

const inheritedHooks = (suite: RegisteredSuite, key: 'beforeEach' | 'afterEach') => {
  const chain: RegisteredSuite[] = []
  for (let current: RegisteredSuite | undefined = suite; current != null; current = current.parent) {
    appendTestValue(chain, current)
  }
  const hooks: HookCallback[] = []
  for (let offset = 0; offset < chain.length; offset += 1) {
    const index = key === 'beforeEach' ? chain.length - offset - 1 : offset
    const source = chain[index]![key]
    for (let hookIndex = 0; hookIndex < source.length; hookIndex += 1) {
      appendTestValue(hooks, source[hookIndex]!)
    }
  }
  return hooks
}

const casePlatform = (item: RegisteredCase, suite: RegisteredSuite) => {
  if (item.platform != null) return item.platform
  for (let current: RegisteredSuite | undefined = suite; current != null; current = current.parent) {
    if (current.platform != null) return current.platform
  }
  return undefined
}

const suitePlatform = (suite: RegisteredSuite) => {
  for (let current: RegisteredSuite | undefined = suite; current != null; current = current.parent) {
    if (current.platform != null) return current.platform
  }
  return undefined
}

const suiteSkipped = (suite: RegisteredSuite) => {
  for (let current: RegisteredSuite | undefined = suite; current?.parent != null; current = current.parent) {
    if (current.skipped) return true
  }
  return false
}

export const runRegisteredTests = async (
  root: RegisteredSuite,
  platform: HolonomyTestPlatform
): Promise<TestRunSummary> => {
  const startedAt = NOW()
  const results: TestCaseResult[] = []

  const runCase = async (item: RegisteredCase, suite: RegisteredSuite, path: readonly string[]) => {
    const target = casePlatform(item, suite)
    if (item.skipped || suiteSkipped(suite) || (target != null && target !== platform)) {
      appendTestValue(
        results,
        freezeTestValue({
          durationMs: 0,
          name: item.name,
          path,
          ...(target == null ? {} : { platform: target }),
          status: 'skipped'
        })
      )
      return
    }
    const caseStartedAt = NOW()
    let caseFailure: TestFailure | undefined
    try {
      await runHooks(inheritedHooks(suite, 'beforeEach'))
      await item.callback!(freezeTestValue({ name: item.name }))
    } catch (error) {
      caseFailure = failure(error)
    } finally {
      try {
        await runHooks(inheritedHooks(suite, 'afterEach'))
      } catch (error) {
        caseFailure ??= failure(error)
      }
    }
    appendTestValue(
      results,
      freezeTestValue({
        durationMs: maxTestNumber(0, NOW() - caseStartedAt),
        ...(caseFailure == null ? {} : { failure: caseFailure }),
        name: item.name,
        path,
        ...(target == null ? {} : { platform: target }),
        status: caseFailure == null ? 'passed' : 'failed'
      })
    )
  }

  const runSuite = async (
    suite: RegisteredSuite,
    parentPath: readonly string[],
    inheritedSetupFailure?: TestFailure
  ) => {
    const path: string[] = []
    for (let index = 0; index < parentPath.length; index += 1) appendTestValue(path, parentPath[index]!)
    if (suite.name !== '') appendTestValue(path, suite.name)
    const target = suitePlatform(suite)
    const matches = !suiteSkipped(suite) && (target == null || target === platform)
    const entered = matches && inheritedSetupFailure == null
    let setupFailure = inheritedSetupFailure
    if (entered) {
      try {
        await runHooks(suite.before)
      } catch (error) {
        setupFailure = failure(error)
      }
    }
    for (let index = 0; index < suite.children.length; index += 1) {
      const child = suite.children[index]!
      if ('children' in child) await runSuite(child, path, setupFailure)
      else if (setupFailure == null) await runCase(child, suite, path)
      else {
        const childTarget = casePlatform(child, suite)
        if (child.skipped || suiteSkipped(suite) || (childTarget != null && childTarget !== platform)) {
          await runCase(child, suite, path)
        } else {
          appendTestValue(
            results,
            freezeTestValue({
              durationMs: 0,
              failure: setupFailure,
              name: child.name,
              path,
              ...(childTarget == null ? {} : { platform: childTarget }),
              status: 'failed'
            })
          )
        }
      }
    }
    if (entered) {
      try {
        await runHooks(suite.after)
      } catch (error) {
        appendTestValue(
          results,
          freezeTestValue({
            durationMs: 0,
            failure: failure(error),
            name: 'after hook',
            path,
            ...(target == null ? {} : { platform: target }),
            status: 'failed'
          })
        )
      }
    }
  }

  await runSuite(root, [])
  const common: TestCaseResult[] = []
  const platformResults: TestCaseResult[] = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!
    appendTestValue(result.platform == null ? common : platformResults, result)
  }
  const count = (items: readonly TestCaseResult[], status: TestCaseResult['status']) => {
    let total = 0
    for (let index = 0; index < items.length; index += 1) if (items[index]!.status === status) total += 1
    return total
  }
  return freezeTestValue({
    common: freezeTestValue({ failed: count(common, 'failed'), passed: count(common, 'passed'), total: common.length }),
    durationMs: maxTestNumber(0, NOW() - startedAt),
    failed: count(results, 'failed'),
    passed: count(results, 'passed'),
    platform,
    platformVerification: freezeTestValue({
      failed: count(platformResults, 'failed'),
      passed: count(platformResults, 'passed'),
      skipped: count(platformResults, 'skipped'),
      total: count(platformResults, 'passed') + count(platformResults, 'failed')
    }),
    results: freezeTestValue(results),
    skipped: count(results, 'skipped'),
    total: results.length
  })
}
