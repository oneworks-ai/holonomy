import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/holonomy-module-loader.js'
import type { HostModuleLoaderPort } from '../../../packages/runtime/src/module-loader/types.js'

const ROOT = 'app:///bundle/'
const PARENT = `${ROOT}entry.mjs`

const fixture = (files: Record<string, string>) => {
  const sources = new Map(Object.entries(files).map(([path, source]) => [new URL(path, ROOT).toString(), source]))
  const reads: string[] = []
  const port: HostModuleLoaderPort = {
    readModule(url) {
      reads.push(url)
      const source = sources.get(url)
      if (source == null) return null
      const bytes = new TextEncoder().encode(source)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    syntheticNodeModules: {}
  }
  return { loader: new HolonomyModuleLoader(port, { rootUrl: ROOT }), reads }
}

describe('exact local ESM resolution', () => {
  it('does not probe extensions or directory indexes for relative imports', async () => {
    const { loader, reads } = fixture({
      'file.js': 'export default 1',
      'directory/index.js': 'export default 2'
    })
    await expect(loader.resolve('./file', PARENT, 'import')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    await expect(loader.resolve('./directory', PARENT, 'import')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    expect(reads).toEqual([`${ROOT}file`, `${ROOT}directory`])
  })

  it('selects a real extensionless file over an extension candidate in an ESM graph', async () => {
    const { loader, reads } = fixture({
      'package.json': '{"type":"module"}',
      'entry.mjs': "import value from './physical'; export default value",
      physical: 'export default 42',
      'physical.js': 'export default 1'
    })
    const plan = await loader.createPlan('./entry.mjs')
    expect(plan.modules.map(module => module.url)).toContain(`${ROOT}physical`)
    expect(plan.modules.map(module => module.url)).not.toContain(`${ROOT}physical.js`)
    expect(reads).not.toContain(`${ROOT}physical.js`)
  })

  it('keeps import and require resolution separate while preserving CommonJS fallback', async () => {
    const { loader } = fixture({
      'file.js': 'module.exports = 1',
      'directory/index.js': 'module.exports = 2'
    })
    expect(await loader.resolve('./file', PARENT, 'require')).toBe(`${ROOT}file.js`)
    await expect(loader.resolve('./file', PARENT, 'import')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    expect(await loader.resolve('./directory/', PARENT, 'require')).toBe(`${ROOT}directory/index.js`)
    await expect(loader.resolve('./directory/', PARENT, 'import')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    expect(await loader.resolve('./file', PARENT, 'require')).toBe(`${ROOT}file.js`)
  })

  it('prefers a physical extensionless CommonJS file and keeps trailing slash on directory indexes', async () => {
    const { loader, reads } = fixture({
      physical: 'module.exports = 42',
      'physical.js': 'module.exports = 1',
      'directory/.js': 'module.exports = 3',
      'directory/index.js': 'module.exports = 2',
      'node_modules/pkg/package.json': '{"main":"physical"}',
      'node_modules/pkg/physical': 'module.exports = 43',
      'node_modules/pkg/physical.js': 'module.exports = 4'
    })
    expect(await loader.resolve('./physical', PARENT, 'require')).toBe(`${ROOT}physical`)
    expect(await loader.resolve('./directory/', PARENT, 'require')).toBe(`${ROOT}directory/index.js`)
    expect(await loader.resolve('pkg', PARENT, 'require')).toBe(`${ROOT}node_modules/pkg/physical`)
    expect(reads).not.toContain(`${ROOT}directory/.js`)
    expect(reads).not.toContain(`${ROOT}physical.js`)
  })

  it('keeps exact absolute and query/empty-fragment identities', async () => {
    const { loader, reads } = fixture({
      'exact.mjs?revision=1#': 'export default 1',
      'exact.mjs?revision=2#': 'export default 2',
      'other.mjs': 'export default 3'
    })
    expect(await loader.resolve('./exact.mjs?revision=1#', PARENT, 'import'))
      .toBe(`${ROOT}exact.mjs?revision=1#`)
    expect(await loader.resolve(`${ROOT}exact.mjs?revision=2#`, PARENT, 'import'))
      .toBe(`${ROOT}exact.mjs?revision=2#`)
    expect(await loader.resolve('./other.mjs', PARENT, 'import')).toBe(`${ROOT}other.mjs`)
    await expect(loader.resolve('./exact.mjs?revision=1', PARENT, 'import')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    expect(reads).not.toContain(`${ROOT}exact.mjs`)
  })
})
