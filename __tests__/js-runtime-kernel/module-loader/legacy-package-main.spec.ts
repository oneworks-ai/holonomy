import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/holonomy-module-loader.js'
import type { HostModuleLoaderPort } from '../../../packages/runtime/src/module-loader/types.js'

const ROOT = 'app:///bundle/'

const fixture = (files: Record<string, string>) => {
  const sources = new Map(Object.entries(files).map(([path, source]) => [new URL(path, ROOT).toString(), source]))
  const port: HostModuleLoaderPort = {
    readModule(url) {
      const source = sources.get(url)
      if (source == null) return null
      const bytes = new TextEncoder().encode(source)
      return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    },
    syntheticNodeModules: {}
  }
  return new HolonomyModuleLoader(port, { rootUrl: ROOT })
}

describe('legacy package entry fields', () => {
  it('joins relative directory index candidates without changing file precedence or query identity', async () => {
    const loader = fixture({
      'dir.js': 'module.exports = 1',
      'dir/index.js': 'module.exports = 2',
      'dir/index.js?revision=2': 'module.exports = 3'
    })
    const parent = `${ROOT}entry.cjs`
    expect(await loader.resolve('./dir', parent, 'require')).toBe(`${ROOT}dir.js`)
    expect(await loader.resolve('./dir/', parent, 'require')).toBe(`${ROOT}dir/index.js`)
    expect(await loader.resolve('./dir/?revision=2', parent, 'require')).toBe(`${ROOT}dir/index.js?revision=2`)
    await expect(loader.resolve('./dir/#fragment', parent, 'require')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_INVALID_URL'
    })
  })

  it('accepts a published bare main path and preserves canonical subpath identity', async () => {
    const loader = fixture({
      'node_modules/semver/package.json': JSON.stringify({ name: 'semver', main: 'index.js' }),
      'node_modules/semver/index.js': 'module.exports = 42'
    })
    expect(await loader.resolve('semver', `${ROOT}entry.cjs`, 'require')).toBe(`${ROOT}node_modules/semver/index.js`)
    expect(await loader.resolve('semver/index.js', `${ROOT}entry.cjs`, 'require')).toBe(
      `${ROOT}node_modules/semver/index.js`
    )
  })

  it('accepts nested legacy main/module paths for the respective conditions', async () => {
    const loader = fixture({
      'node_modules/pkg/package.json': JSON.stringify({ main: 'lib/index.cjs', module: 'esm/index.mjs' }),
      'node_modules/pkg/lib/index.cjs': 'module.exports = 1',
      'node_modules/pkg/esm/index.mjs': 'export default 1'
    })
    expect(await loader.resolve('pkg', `${ROOT}entry.cjs`, 'require')).toBe(`${ROOT}node_modules/pkg/lib/index.cjs`)
    expect(await loader.resolve('pkg', `${ROOT}entry.mjs`, 'import')).toBe(`${ROOT}node_modules/pkg/esm/index.mjs`)
  })

  it('keeps exports exact and rejects absolute, URL and parent legacy targets', async () => {
    const exported = fixture({
      'node_modules/pkg/package.json': JSON.stringify({ exports: 'index.js', main: 'lib/index.js' }),
      'node_modules/pkg/index.js': 'module.exports = 1',
      'node_modules/pkg/lib/index.js': 'module.exports = 2'
    })
    await expect(exported.resolve('pkg')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })

    const imported = fixture({
      'package.json': JSON.stringify({ imports: { '#bad': '../outside.js' } }),
      'index.js': 'export default 1'
    })
    await expect(imported.resolve('#bad')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })

    for (const main of ['../outside.js', '/absolute.js', 'https://example.com/file.js']) {
      const loader = fixture({
        'node_modules/pkg/package.json': JSON.stringify({ main }),
        'node_modules/pkg/index.js': 'module.exports = 1'
      })
      await expect(loader.resolve('pkg')).rejects.toMatchObject({ code: 'ERR_HOLONOMY_MODULE_INVALID_PACKAGE_CONFIG' })
    }
  })

  it('keeps the default index fallback for an absent main', async () => {
    const loader = fixture({
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg' }),
      'node_modules/pkg/index.js': 'module.exports = 1'
    })
    expect(await loader.resolve('pkg', `${ROOT}entry.cjs`, 'require')).toBe(`${ROOT}node_modules/pkg/index.js`)
  })

  it('uses the default index for an empty main and skips an empty module field', async () => {
    const emptyMain = fixture({
      'node_modules/pkg/package.json': JSON.stringify({ main: '' }),
      'node_modules/pkg/index.js': 'module.exports = 1'
    })
    expect(await emptyMain.resolve('pkg', `${ROOT}entry.cjs`, 'require')).toBe(`${ROOT}node_modules/pkg/index.js`)

    const emptyModule = fixture({
      'node_modules/pkg/package.json': JSON.stringify({ module: '', main: 'lib/index.cjs' }),
      'node_modules/pkg/lib/index.cjs': 'module.exports = 1'
    })
    expect(await emptyModule.resolve('pkg', `${ROOT}entry.mjs`, 'import')).toBe(`${ROOT}node_modules/pkg/lib/index.cjs`)
  })

  it('does not accept empty exports or imports targets', async () => {
    const exported = fixture({
      'node_modules/pkg/package.json': JSON.stringify({ exports: '' }),
      'node_modules/pkg/index.js': 'module.exports = 1'
    })
    await expect(exported.resolve('pkg')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })

    const imported = fixture({
      'package.json': JSON.stringify({ imports: { '#empty': '' } })
    })
    await expect(imported.resolve('#empty')).rejects.toMatchObject({ code: 'ERR_INVALID_PACKAGE_TARGET' })
  })
})
