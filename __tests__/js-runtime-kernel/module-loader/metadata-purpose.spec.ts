import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { HolonomyModuleLoader } from '../../../packages/runtime/src/module-loader/index.js'
import type { HostModuleLoaderPort, HostModuleSource } from '../../../packages/runtime/src/module-loader/index.js'

const ROOT = 'app:///bundle/'
const PACKAGE = `${ROOT}node_modules/example/`
const encoder = new TextEncoder()
const source = (text: string, canonicalUrl?: string, metadataOnly?: boolean): HostModuleSource => {
  const bytes = encoder.encode(text)
  return {
    bytes,
    canonicalUrl,
    ...(metadataOnly === true ? { metadataOnly: true } : {}),
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

describe('host module read purpose', () => {
  it('requests package manifests as metadata and preserves the restriction in a source closure', async () => {
    const requests: Array<{ purpose: unknown; url: string }> = []
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        requests.push({ purpose: Reflect.get(context, 'purpose'), url })
        if (url === `${PACKAGE}package.json`) {
          return source('{"name":"example","exports":"./index.mjs"}', undefined, true)
        }
        if (url === `${ROOT}entry.mjs`) return source("import 'example'")
        if (url === `${PACKAGE}index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    const closure = await loader.createSourceClosure('./entry.mjs', {
      isExternalModule: () => false
    })

    expect(
      requests.filter(request => request.url.endsWith('/package.json'))
        .every(request => request.purpose === 'packageMetadata')
    ).toBe(true)
    expect(
      requests.filter(request => !request.url.endsWith('/package.json'))
        .every(request => request.purpose === 'module')
    ).toBe(true)
    expect(closure.reads.find(read => read.url === `${PACKAGE}package.json`))
      .toMatchObject({ metadataOnly: true })
    expect(closure.reads.find(read => read.url === `${ROOT}entry.mjs`))
      .not.toHaveProperty('metadataOnly')
  })

  it('re-asks the Host for a module grant after a metadata-only package cache hit', async () => {
    const requests: Array<{ purpose: unknown; url: string }> = []
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        const purpose = Reflect.get(context, 'purpose')
        requests.push({ purpose, url })
        if (url === `${PACKAGE}package.json`) {
          if (purpose === 'module') throw new Error('module read denied')
          return source('{"name":"example","exports":"./index.mjs"}', undefined, true)
        }
        if (url === `${PACKAGE}index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect(await loader.resolve('example')).toBe(`${PACKAGE}index.mjs`)
    await expect(loader.createPlan('./node_modules/example/package.json')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
    })
    expect(
      requests.filter(request => request.url === `${PACKAGE}package.json`)
        .map(request => request.purpose)
    ).toEqual(['packageMetadata', 'module'])
  })

  it('re-asks through a package alias rather than treating its canonical cache as module authority', async () => {
    const physicalPackage = `${ROOT}vendor/example/`
    const requests: Array<{ purpose: unknown; url: string }> = []
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        const purpose = Reflect.get(context, 'purpose')
        requests.push({ purpose, url })
        if (url === `${PACKAGE}package.json`) {
          if (purpose === 'module') throw new Error('module read denied')
          return source('{"name":"example","exports":"./index.mjs"}', `${physicalPackage}package.json`, true)
        }
        if (url === `${physicalPackage}index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect(await loader.resolve('example')).toBe(`${physicalPackage}index.mjs`)
    await expect(loader.createPlan('./node_modules/example/package.json')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
    })
    expect(
      requests.filter(request => request.url === `${PACKAGE}package.json`)
        .map(request => request.purpose)
    ).toEqual(['packageMetadata', 'module'])
  })

  it('re-asks for an ordinary module grant even when metadata carried no restriction', async () => {
    const purposes: unknown[] = []
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        if (url === `${PACKAGE}package.json`) {
          purposes.push(context.purpose)
          return source('{"name":"example","exports":"./index.mjs"}')
        }
        if (url === `${PACKAGE}index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect(await loader.resolve('example')).toBe(`${PACKAGE}index.mjs`)
    expect((await loader.createPlan('./node_modules/example/package.json')).modules[0]?.format).toBe('json')
    expect(purposes).toEqual(['packageMetadata', 'module'])
  })

  it('does not transfer a canonical module grant to a metadata-only alias', async () => {
    const physicalPackage = `${ROOT}vendor/example/`
    const requests: Array<{ purpose: unknown; url: string }> = []
    const manifest = '{"name":"example","exports":"./index.mjs"}'
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        const purpose = Reflect.get(context, 'purpose')
        requests.push({ purpose, url })
        if (url === `${physicalPackage}package.json`) return source(manifest)
        if (url === `${PACKAGE}package.json`) {
          if (purpose === 'module') throw new Error('module read denied')
          return source(manifest, `${physicalPackage}package.json`, true)
        }
        if (url === `${physicalPackage}index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect((await loader.createPlan('./vendor/example/package.json')).entryUrl)
      .toBe(`${physicalPackage}package.json`)
    expect(await loader.resolve('example')).toBe(`${physicalPackage}index.mjs`)
    await expect(loader.createPlan('./node_modules/example/package.json')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
    })
    expect(
      requests.filter(request => request.url === `${PACKAGE}package.json`)
        .map(request => request.purpose)
    ).toEqual(['packageMetadata', 'module'])
  })

  it('checks a metadata-only alias on load after another alias cached the canonical module', async () => {
    const sourceAlias = `${ROOT}source-alias/package.json`
    const canonical = `${ROOT}physical/package.json`
    const manifest = '{"name":"example","exports":"./index.mjs"}'
    const packagePurposes: string[] = []
    let aliasModuleAllowed = false
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        if (url === `${PACKAGE}package.json`) {
          packagePurposes.push(context.purpose)
          if (context.purpose === 'module' && !aliasModuleAllowed) throw new Error('alias module read denied')
          return source(manifest, canonical, context.purpose === 'packageMetadata')
        }
        if (url === sourceAlias) return source(manifest, canonical)
        if (url === `${ROOT}physical/index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect(await loader.resolve('example')).toBe(`${ROOT}physical/index.mjs`)
    expect((await loader.createPlan(sourceAlias)).entryUrl).toBe(canonical)
    await expect(loader.load(`${PACKAGE}package.json`)).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
    })
    const synchronousFailures: unknown[] = []
    for (
      const attempt of [
        () => loader.beginEvaluation(`${PACKAGE}package.json`),
        () => loader.createRequire(`${PACKAGE}package.json`)
      ]
    ) {
      try {
        attempt()
      } catch (error) {
        synchronousFailures.push(error)
      }
    }
    expect(synchronousFailures).toEqual([
      expect.objectContaining({ code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED' }),
      expect.objectContaining({ code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED' })
    ])
    expect(packagePurposes).toEqual(['packageMetadata', 'module'])
    aliasModuleAllowed = true
    expect((await loader.load(`${PACKAGE}package.json`)).url).toBe(canonical)
    expect((await loader.load(`${PACKAGE}package.json`)).url).toBe(canonical)
    expect(packagePurposes).toEqual(['packageMetadata', 'module', 'module'])
    expect(loader.beginEvaluation(`${PACKAGE}package.json`).url).toBe(canonical)
    expect(loader.createRequire(`${PACKAGE}package.json`)).toBeDefined()
  })

  it('accepts an exact module regrant and removes the closure restriction', async () => {
    const requests: Array<{ purpose: unknown; url: string }> = []
    const manifest = '{"name":"example","exports":"./index.mjs"}'
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        const purpose = Reflect.get(context, 'purpose')
        requests.push({ purpose, url })
        if (url === `${PACKAGE}package.json`) {
          return source(manifest, undefined, purpose === 'packageMetadata')
        }
        if (url === `${ROOT}entry.mjs`) {
          return source("import 'example'; import './node_modules/example/package.json'")
        }
        if (url === `${PACKAGE}index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })
    const closure = await loader.createSourceClosure('./entry.mjs', {
      isExternalModule: () => false
    })

    expect(
      requests.filter(request => request.url === `${PACKAGE}package.json`)
        .map(request => request.purpose)
    ).toEqual(['packageMetadata', 'module'])
    expect(closure.reads.find(read => read.url === `${PACKAGE}package.json`))
      .not.toHaveProperty('metadataOnly')
  })

  it('restores the metadata-only cache grant after a later graph failure', async () => {
    let moduleAllowed = true
    const requests: string[] = []
    const manifest = '{"name":"example","exports":"./index.mjs"}'
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        const purpose = Reflect.get(context, 'purpose')
        if (url === `${PACKAGE}package.json`) {
          requests.push(String(purpose))
          if (purpose === 'module' && !moduleAllowed) throw new Error('module read denied')
          return source(manifest, undefined, purpose === 'packageMetadata')
        }
        if (url === `${PACKAGE}index.mjs`) return source('export const value = 1')
        if (url === `${ROOT}entry.mjs`) {
          return source("import './node_modules/example/package.json'; import './missing.mjs'")
        }
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect(await loader.resolve('example')).toBe(`${PACKAGE}index.mjs`)
    await expect(loader.createPlan('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    moduleAllowed = false
    await expect(loader.createPlan('./node_modules/example/package.json')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
    })
    expect(requests).toEqual(['packageMetadata', 'module', 'module'])
  })

  it('keeps a missing metadata probe separate from a later module read', async () => {
    const purposes: unknown[] = []
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        if (url !== `${PACKAGE}package.json`) return null
        purposes.push(context.purpose)
        return context.purpose === 'packageMetadata' ? null : source('{"ordinary":true}')
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    await expect(loader.resolve('example')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_NOT_FOUND'
    })
    expect((await loader.createPlan('./node_modules/example/package.json')).modules[0]?.format).toBe('json')
    expect(purposes).toEqual(['packageMetadata', 'module'])
  })

  it('rejects a metadata-only response to a module-purpose read', async () => {
    const port: HostModuleLoaderPort = {
      readModule: url => url === `${PACKAGE}package.json` ? source('{"ordinary":true}', undefined, true) : null,
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })
    await expect(loader.createPlan('./node_modules/example/package.json')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_HOST_READ_FAILED'
    })
  })

  it.each([
    [
      'changed canonical URL',
      `${ROOT}vendor/other/package.json`,
      '{"name":"example","exports":"./index.mjs"}',
      'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    ],
    [
      'changed bytes',
      `${ROOT}vendor/example/package.json`,
      '{"name":"other","exports":"./index.mjs"}',
      'ERR_HOLONOMY_MODULE_INTEGRITY'
    ]
  ])('rejects %s during metadata-to-module cache upgrade', async (_name, moduleCanonical, moduleText, code) => {
    const canonical = `${ROOT}vendor/example/package.json`
    const manifest = '{"name":"example","exports":"./index.mjs"}'
    const port: HostModuleLoaderPort = {
      readModule(url, context) {
        if (url === `${PACKAGE}package.json`) {
          return context.purpose === 'packageMetadata'
            ? source(manifest, canonical, true)
            : source(moduleText, moduleCanonical)
        }
        if (url === `${ROOT}vendor/example/index.mjs`) return source('export const value = 1')
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { allowJsonModules: true, rootUrl: ROOT })

    expect(await loader.resolve('example')).toBe(`${ROOT}vendor/example/index.mjs`)
    await expect(loader.createPlan('./node_modules/example/package.json')).rejects.toMatchObject({ code })
  })

  it('rejects a malformed Host metadata restriction flag', async () => {
    const port: HostModuleLoaderPort = {
      readModule(url) {
        return url === `${PACKAGE}package.json`
          ? {
            ...source('{"name":"example","exports":"./index.mjs"}'),
            metadataOnly: 'yes'
          } as unknown as HostModuleSource
          : null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: ROOT })
    await expect(loader.resolve('example')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_SOURCE_INVALID'
    })
  })
})
