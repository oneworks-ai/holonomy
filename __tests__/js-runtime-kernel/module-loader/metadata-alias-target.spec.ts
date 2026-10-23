import { createHash } from 'node:crypto'

import { expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/index.js'
import type { HostModuleLoaderPort, HostModuleSource } from '../../../packages/runtime/src/module-loader/index.js'

const root = 'app:///bundle/'
const packageRoot = `${root}node_modules/p/`
const metadataAlias = `${packageRoot}alias-b/package.json`
const sourceAlias = `${packageRoot}alias-a/package.json`
const canonical = `${packageRoot}physical/package.json`
const manifest = '{"name":"inner","exports":"./index.mjs"}'
const source = (value: string, canonicalUrl?: string, metadataOnly?: true): HostModuleSource => {
  const bytes = new TextEncoder().encode(value)
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(canonicalUrl == null ? {} : { canonicalUrl }),
    ...(metadataOnly == null ? {} : { metadataOnly })
  }
}

const fixture = () => {
  const aliasPurposes: string[] = []
  const port: HostModuleLoaderPort = {
    readModule(url, context) {
      if (url === metadataAlias) {
        aliasPurposes.push(context.purpose)
        if (context.purpose === 'module') throw new Error('metadata alias cannot be a module')
        return source(manifest, canonical, true)
      }
      if (url === sourceAlias) return source(manifest, canonical)
      if (url === `${packageRoot}package.json`) {
        return source(
          '{"name":"p","type":"module","exports":{"./raw":"./alias-b/package.json"},"imports":{"#raw":"./alias-b/package.json"}}'
        )
      }
      if (url === `${packageRoot}entry.mjs`) return source("import '#raw'")
      return null
    },
    syntheticNodeModules: {}
  }
  const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: root })
  return { aliasPurposes, loader }
}

const warmAliases = async (loader: HolonomyModuleLoader) => {
  expect(await loader.resolve('inner', `${packageRoot}alias-b/entry.mjs`))
    .toBe(`${packageRoot}physical/index.mjs`)
  expect((await loader.createPlan(sourceAlias)).entryUrl).toBe(canonical)
}

it('reauthorizes an exports target whose metadata alias shares a cached canonical JSON module', async () => {
  const { aliasPurposes, loader } = fixture()
  await warmAliases(loader)
  await expect(loader.createPlan('p/raw')).rejects.toMatchObject({
    code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
  })
  expect(aliasPurposes).toEqual(['packageMetadata', 'module'])
})

it('reauthorizes an imports target whose metadata alias shares a cached canonical JSON module', async () => {
  const { aliasPurposes, loader } = fixture()
  await warmAliases(loader)
  await expect(loader.createPlan(`${packageRoot}entry.mjs`)).rejects.toMatchObject({
    code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
  })
  expect(aliasPurposes).toEqual(['packageMetadata', 'module'])
})

it('retains the requested target through a resolution-cache hit after metadata alias discovery', async () => {
  const { aliasPurposes, loader } = fixture()
  expect(await loader.resolve('p/raw')).toBe(metadataAlias)
  expect(aliasPurposes).toEqual([])
  await warmAliases(loader)
  await expect(loader.createPlan('p/raw')).rejects.toMatchObject({
    code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
  })
  expect(aliasPurposes).toEqual(['packageMetadata', 'module'])
})
