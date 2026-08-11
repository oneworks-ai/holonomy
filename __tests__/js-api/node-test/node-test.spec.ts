import { describe, expect, it } from 'vitest'

import { createNodeTestSyntheticModules } from '../../../src/node-test/index.js'

describe('node:test runtime', () => {
  it('runs common cases and excludes platform cases from the common denominator', async () => {
    const modules = createNodeTestSyntheticModules('android')
    const { describe: registerSuite, it: registerCase, run } = modules['node:test']
    registerSuite('common', () => {
      registerCase('passes', () => {})
      registerCase('fails', () => {
        throw new Error('expected failure')
      })
      registerCase.holonomy.android('android implementation', () => {})
      registerCase.holonomy.ios('ios implementation', () => {})
    })
    const summary = await run()
    expect(summary.common).toEqual({ failed: 1, passed: 1, total: 2 })
    expect(summary.platformVerification).toEqual({ failed: 0, passed: 1, skipped: 1, total: 1 })
    expect(summary.failed).toBe(1)
    expect(summary.results.map(result => result.status)).toEqual(['passed', 'failed', 'passed', 'skipped'])
  })

  it('does not run nested hooks inherited from a non-matching platform suite', async () => {
    const modules = createNodeTestSyntheticModules('android')
    const {
      after,
      afterEach,
      before,
      beforeEach,
      describe: registerSuite,
      it: registerCase,
      run
    } = modules['node:test']
    const calls: string[] = []
    registerSuite.holonomy.ios('iOS implementation', () => {
      before(() => calls.push('outer before'))
      after(() => calls.push('outer after'))
      registerSuite('nested', () => {
        before(() => calls.push('nested before'))
        after(() => calls.push('nested after'))
        beforeEach(() => calls.push('nested beforeEach'))
        afterEach(() => calls.push('nested afterEach'))
        registerCase('case', () => calls.push('case'))
      })
    })

    const summary = await run()
    expect(calls).toEqual([])
    expect(summary.common).toEqual({ failed: 0, passed: 0, total: 0 })
    expect(summary.platformVerification).toEqual({ failed: 0, passed: 0, skipped: 1, total: 0 })
  })

  it('attributes a matching platform suite hook failure only to platform verification', async () => {
    const modules = createNodeTestSyntheticModules('android')
    const { before, describe: registerSuite, it: registerCase, run } = modules['node:test']
    registerSuite.holonomy.android('Android implementation', () => {
      before(() => {
        throw new Error('platform setup failed')
      })
      registerCase('case', () => {})
    })

    const summary = await run()
    expect(summary.common).toEqual({ failed: 0, passed: 0, total: 0 })
    expect(summary.platformVerification).toEqual({ failed: 1, passed: 0, skipped: 0, total: 1 })
    expect(summary.results).toEqual([
      expect.objectContaining({ platform: 'android', status: 'failed' })
    ])
  })

  it('runs root and nested per-case hooks in setup and cleanup order', async () => {
    const modules = createNodeTestSyntheticModules('android')
    const {
      afterEach,
      beforeEach,
      describe: registerSuite,
      it: registerCase,
      run
    } = modules['node:test']
    const calls: string[] = []
    beforeEach(() => calls.push('root beforeEach'))
    afterEach(() => calls.push('root afterEach'))
    registerSuite('nested', () => {
      beforeEach(() => calls.push('nested beforeEach'))
      afterEach(() => calls.push('nested afterEach'))
      registerCase('case', () => calls.push('case'))
    })

    const summary = await run()
    expect(calls).toEqual([
      'root beforeEach',
      'nested beforeEach',
      'case',
      'nested afterEach',
      'root afterEach'
    ])
    expect(summary.common).toEqual({ failed: 0, passed: 1, total: 1 })
  })

  it('propagates an ancestor before failure to every descendant without entering child suites', async () => {
    const modules = createNodeTestSyntheticModules('android')
    const { after, before, describe: registerSuite, it: registerCase, run } = modules['node:test']
    const calls: string[] = []
    registerSuite('parent', () => {
      before(() => {
        calls.push('parent before')
        throw new Error('parent setup failed')
      })
      after(() => calls.push('parent after'))
      registerSuite('child', () => {
        before(() => calls.push('child before'))
        after(() => calls.push('child after'))
        registerCase('first', () => calls.push('first'))
        registerCase('second', () => calls.push('second'))
      })
    })

    const summary = await run()
    expect(calls).toEqual(['parent before', 'parent after'])
    expect(summary.common).toEqual({ failed: 2, passed: 0, total: 2 })
    expect(summary.results).toEqual([
      expect.objectContaining({
        failure: expect.objectContaining({ message: 'parent setup failed' }),
        status: 'failed'
      }),
      expect.objectContaining({
        failure: expect.objectContaining({ message: 'parent setup failed' }),
        status: 'failed'
      })
    ])
  })

  it('rejects a child platform that conflicts with its ancestor without running parent hooks', async () => {
    const modules = createNodeTestSyntheticModules('android')
    const { before, describe: registerSuite, it: registerCase, run } = modules['node:test']
    const calls: string[] = []
    expect(() => {
      registerSuite.holonomy.ios('iOS implementation', () => {
        before(() => calls.push('iOS before'))
        registerCase.holonomy.android('conflicting Android case', () => calls.push('case'))
      })
    }).toThrowError(new TypeError('Nested test platform must match its parent suite'))

    const summary = await run()
    expect(calls).toEqual([])
    expect(summary.common).toEqual({ failed: 0, passed: 0, total: 0 })
    expect(summary.platformVerification).toEqual({ failed: 0, passed: 0, skipped: 0, total: 0 })
    expect(summary.results).toEqual([])
  })
})
