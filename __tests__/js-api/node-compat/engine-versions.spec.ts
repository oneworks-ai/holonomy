import { describe, expect, it } from 'vitest'
import { createNodeCoreSyntheticModules } from '../../../src/node-compat/registry.js'
import { createNodeCoreOptions } from './fixtures.js'

describe('engine-owned process versions', () => {
  it('reports native engine versions without inventing a Node version', () => {
    const options = createNodeCoreOptions()
    const versions = { holonomy: '1.0.0', v8: '152.0.0' }
    const process = createNodeCoreSyntheticModules({
      ...options,
      process: { ...options.process, versions }
    })['node:process'].default
    versions.v8 = 'changed'
    expect(process.versions).toEqual({ holonomy: '1.0.0', v8: '152.0.0' })
    expect(process.versions.node).toBeUndefined()
    expect(Object.isFrozen(process.versions)).toBe(true)
  })
})
