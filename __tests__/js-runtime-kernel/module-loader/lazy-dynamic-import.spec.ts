import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/index.js'

const root = 'app:///bundle/'
const fixture = (files: Record<string, string>, captureDynamicImports = false) => {
  const reads: string[] = []
  const loader = new HolonomyModuleLoader({
    syntheticNodeModules: {},
    readModule(url) {
      reads.push(url)
      const source = files[url.slice(root.length)]
      if (source == null) return null
      const bytes = new TextEncoder().encode(source)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  }, { rootUrl: root, captureDynamicImports })
  return { loader, reads }
}

describe('literal dynamic import runtime boundary', () => {
  it('does not fail or read missing and invalid lazy targets while planning the entry', async () => {
    const { loader, reads } = fixture({
      'entry.mjs': "export const later = () => import('./missing.mjs'); import('./invalid.mjs').catch(() => {});",
      'invalid.mjs': 'export const = invalid syntax'
    })
    const plan = await loader.createPlan('./entry.mjs')
    expect(plan.modules).toHaveLength(1)
    expect(plan.modules[0]!.dependencies).toEqual([
      { kind: 'dynamic-import', specifier: './missing.mjs', resolvedUrl: null, interop: null },
      { kind: 'dynamic-import', specifier: './invalid.mjs', resolvedUrl: null, interop: null }
    ])
    expect(reads).not.toContain(`${root}missing.mjs`)
    expect(reads).not.toContain(`${root}invalid.mjs`)
    await expect(loader.createPlan('./missing.mjs', { parentUrl: `${root}entry.mjs` })).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    await expect(loader.createPlan('./invalid.mjs', { parentUrl: `${root}entry.mjs` })).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    })
  })

  it('still collects literal targets in the separate non-executable source closure', async () => {
    const { loader } = fixture({
      'entry.mjs': "export const later = () => import('./later.mjs')",
      'later.mjs': 'export default 42'
    })
    const closure = await loader.createSourceClosure('./entry.mjs', { isExternalModule: () => false })
    expect(closure.reads.map(read => read.url)).toContain(`${root}later.mjs`)
    const plan = await loader.createPlan('./entry.mjs')
    expect(plan.modules.map(module => module.url)).toEqual([`${root}entry.mjs`])
    expect(plan.modules[0]!.dependencies[0]).toMatchObject({ resolvedUrl: null })
  })

  it('explicitly captures literal dependencies for immutable Host executable graphs', async () => {
    const { loader } = fixture({
      'entry.mjs': "export const later = () => import('./later.mjs')",
      'later.mjs': 'export default 42'
    }, true)
    const plan = await loader.createPlan('./entry.mjs')
    expect(plan.modules.map(module => module.url)).toContain(`${root}later.mjs`)
    expect(plan.modules.find(module => module.url === `${root}entry.mjs`)!.dependencies[0]).toMatchObject({
      resolvedUrl: `${root}later.mjs`
    })
    expect(await loader.createPlan('./entry.mjs')).toEqual(plan)
    const guest = fixture({
      'entry.mjs': "export const later = () => import('./later.mjs')",
      'later.mjs': 'export default 42'
    })
    const lazy = await guest.loader.createPlan('./entry.mjs')
    expect(await guest.loader.createPlan('./entry.mjs')).toEqual(lazy)
    expect(lazy.modules).toHaveLength(1)
    expect(lazy.modules[0]!.dependencies[0]!.resolvedUrl).toBe(null)
  })
})
