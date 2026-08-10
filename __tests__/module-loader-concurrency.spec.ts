import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS, HolonomyModuleLoader } from '../src/index.js'
import type { HolonomyModuleLoaderOptions, HostModuleLoaderPort, HostModuleSource } from '../src/index.js'
import { setModuleSourceParserForTesting } from '../src/module-loader/source-analysis.js'

const APP_ROOT = 'app:///bundle/'

const hostSource = (source: string): HostModuleSource => {
  const bytes = new TextEncoder().encode(source)
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const createMemoryLoader = (
  sources: Readonly<Record<string, string>>,
  options: Omit<HolonomyModuleLoaderOptions, 'rootUrl'> = {}
) => {
  const reads = new Map<string, number>()
  const port: HostModuleLoaderPort = {
    readModule(canonicalUrl) {
      reads.set(canonicalUrl, (reads.get(canonicalUrl) ?? 0) + 1)
      const source = sources[canonicalUrl]
      return source == null ? null : hostSource(source)
    },
    syntheticNodeModules: {}
  }
  return {
    loader: new HolonomyModuleLoader(port, { rootUrl: APP_ROOT, ...options }),
    reads
  }
}

describe('mobileModuleLoader serialized cache transactions', () => {
  it('serializes concurrent createPlan/load for one URL and publishes one result', async () => {
    const entryUrl = `${APP_ROOT}entry.mjs`
    const gate = deferred()
    let reads = 0
    const port: HostModuleLoaderPort = {
      async readModule(canonicalUrl) {
        if (canonicalUrl !== entryUrl) return null
        reads += 1
        await gate.promise
        return hostSource('export const ready = true')
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    const planned = loader.createPlan('./entry.mjs')
    await Promise.resolve()
    await Promise.resolve()
    const loaded = loader.load(entryUrl)
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(1)
    expect(() => loader.getEvaluation(entryUrl)).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_TRANSACTION_ACTIVE'
    }))

    gate.resolve()
    const [plan, module] = await Promise.all([planned, loaded])
    expect(reads).toBe(1)
    expect(module).toEqual(plan.modules[0])
  })

  it('rolls back only a failed transaction before a queued identical plan succeeds', async () => {
    const entryUrl = `${APP_ROOT}entry.mjs`
    const dependencyUrl = `${APP_ROOT}dependency.mjs`
    const dependencyGate = deferred()
    const dependencyStarted = deferred()
    const reads = new Map<string, number>()
    const port: HostModuleLoaderPort = {
      async readModule(canonicalUrl) {
        const count = (reads.get(canonicalUrl) ?? 0) + 1
        reads.set(canonicalUrl, count)
        if (canonicalUrl === entryUrl) {
          return hostSource("import './dependency.mjs'\nexport const entry = true")
        }
        if (canonicalUrl !== dependencyUrl) return null
        if (count === 1) {
          dependencyStarted.resolve()
          await dependencyGate.promise
          return null
        }
        return hostSource('export const dependency = true')
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    const firstOutcome = loader.createPlan('./entry.mjs').then(
      value => ({ error: undefined, value }),
      (error: unknown) => ({ error, value: undefined })
    )
    const second = loader.createPlan('./entry.mjs')
    await dependencyStarted.promise
    expect(reads.get(dependencyUrl)).toBe(1)

    dependencyGate.resolve()
    const [first, secondPlan] = await Promise.all([firstOutcome, second])
    expect(first.error).toMatchObject({ code: 'ERR_HOLONOMY_MODULE_NOT_FOUND' })
    expect(first.value).toBeUndefined()
    expect(secondPlan.modules.map(module => module.url)).toEqual([dependencyUrl, entryUrl])
    expect(reads.get(entryUrl)).toBe(2)
    expect(reads.get(dependencyUrl)).toBe(2)
  })

  it('preserves query identities across concurrent plans', async () => {
    const reads = new Map<string, number>()
    const port: HostModuleLoaderPort = {
      async readModule(canonicalUrl) {
        reads.set(canonicalUrl, (reads.get(canonicalUrl) ?? 0) + 1)
        const url = new URL(canonicalUrl)
        if (url.pathname !== '/bundle/entry.mjs') return null
        return hostSource('export const queryIdentity = import.meta.url')
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    const [first, second] = await Promise.all([
      loader.createPlan('./entry.mjs?revision=one'),
      loader.createPlan('./entry.mjs?revision=two')
    ])

    expect(first.entryUrl).toBe(`${APP_ROOT}entry.mjs?revision=one`)
    expect(second.entryUrl).toBe(`${APP_ROOT}entry.mjs?revision=two`)
    expect(first.modules[0]?.url).not.toBe(second.modules[0]?.url)
    expect(reads.get(first.entryUrl)).toBe(1)
    expect(reads.get(second.entryUrl)).toBe(1)
  })

  it('shares a complete cyclic graph with a queued identical plan', async () => {
    const cycleAUrl = `${APP_ROOT}cycle-a.mjs`
    const cycleBUrl = `${APP_ROOT}cycle-b.mjs`
    const firstReadGate = deferred()
    const reads = new Map<string, number>()
    const port: HostModuleLoaderPort = {
      async readModule(canonicalUrl) {
        reads.set(canonicalUrl, (reads.get(canonicalUrl) ?? 0) + 1)
        if (canonicalUrl === cycleAUrl) {
          await firstReadGate.promise
          return hostSource("import './cycle-b.mjs'\nexport const a = true")
        }
        if (canonicalUrl === cycleBUrl) {
          return hostSource("import './cycle-a.mjs'\nexport const b = true")
        }
        return null
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    const first = loader.createPlan('./cycle-a.mjs')
    const second = loader.createPlan('./cycle-a.mjs')
    await Promise.resolve()
    await Promise.resolve()
    expect(reads.get(cycleAUrl)).toBe(1)
    firstReadGate.resolve()

    const [firstPlan, secondPlan] = await Promise.all([first, second])
    expect(secondPlan).toEqual(firstPlan)
    expect(reads.get(cycleAUrl)).toBe(1)
    expect(reads.get(cycleBUrl)).toBe(1)
  })
})

describe('mobileModuleLoader resource limits', () => {
  it('freezes resolved limits and accepts a 5000-layer member chain', async () => {
    const source = `export const value = root${'.member'.repeat(5_000)}`
    const { loader } = createMemoryLoader({ [`${APP_ROOT}deep.mjs`]: source })

    expect(Object.isFrozen(DEFAULT_HOLONOMY_MODULE_LOADER_LIMITS)).toBe(true)
    expect(Object.isFrozen(loader.limits)).toBe(true)
    await expect(loader.createPlan('./deep.mjs')).resolves.toMatchObject({
      entryUrl: `${APP_ROOT}deep.mjs`
    })
  })

  it('rejects a source above maxSourceBytes before decode/parse', async () => {
    const { loader } = createMemoryLoader(
      { [`${APP_ROOT}large.mjs`]: 'export const value = 123' },
      { limits: { maxSourceBytes: 8 } }
    )

    await expect(loader.createPlan('./large.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })
  })

  it('rejects total source bytes accumulated by one plan', async () => {
    const first = "import './second.mjs'\nexport const first = 'aaaaaaaaaaaaaaaa'"
    const second = "export const second = 'bbbbbbbbbbbbbbbb'"
    const largest = Math.max(hostSource(first).bytes.byteLength, hostSource(second).bytes.byteLength)
    const { loader } = createMemoryLoader({
      [`${APP_ROOT}first.mjs`]: first,
      [`${APP_ROOT}second.mjs`]: second
    }, {
      limits: {
        maxSourceBytes: 1_024,
        maxTotalSourceBytesPerPlan: largest + 1
      }
    })

    await expect(loader.createPlan('./first.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })
  })

  it('rejects module and dependency counts above their plan limits', async () => {
    const sources = {
      [`${APP_ROOT}first.mjs`]: "import './second.mjs'\nexport const first = true",
      [`${APP_ROOT}second.mjs`]: "import './third.mjs'\nexport const second = true",
      [`${APP_ROOT}third.mjs`]: 'export const third = true'
    }
    const moduleLimited = createMemoryLoader(sources, {
      limits: { maxModules: 2 }
    }).loader
    await expect(moduleLimited.createPlan('./first.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })

    const dependencyLimited = createMemoryLoader({
      ...sources,
      [`${APP_ROOT}first.mjs`]: "import './second.mjs'\nimport './third.mjs'"
    }, {
      limits: { maxDependenciesPerModule: 1 }
    }).loader
    await expect(dependencyLimited.createPlan('./first.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })
  })

  it('rejects AST node and depth budgets with one stable error code', async () => {
    const nodeLimited = createMemoryLoader({
      [`${APP_ROOT}nodes.mjs`]: `export const values = [${'1,'.repeat(100)}0]`
    }, {
      limits: { maxAstNodes: 20 }
    }).loader
    await expect(nodeLimited.createPlan('./nodes.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })

    const depthLimited = createMemoryLoader({
      [`${APP_ROOT}depth.mjs`]: `export const value = root${'.member'.repeat(100)}`
    }, {
      limits: { maxAstDepth: 20 }
    }).loader
    await expect(depthLimited.createPlan('./depth.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    })
  })

  it.each([
    ['RangeError', () => new RangeError('native parser stack detail')],
    ['Acorn capacity SyntaxError', () => new SyntaxError('Not enough stack space to parse input')]
  ])('normalizes parser capacity %s failures without exposing native details', async (_name, createError) => {
    const restoreParser = setModuleSourceParserForTesting(() => {
      throw createError()
    })
    try {
      const { loader } = createMemoryLoader({
        [`${APP_ROOT}parser-capacity.mjs`]: 'export const value = true'
      })
      const outcome = await loader.createPlan('./parser-capacity.mjs').then(
        () => undefined,
        (error: unknown) => error
      )
      expect(outcome).toMatchObject({
        code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
      })
      expect(String(outcome)).not.toContain('native parser stack detail')
      expect(String(outcome)).not.toContain('stack space')
      expect(outcome).not.toBeInstanceOf(RangeError)
    } finally {
      restoreParser()
    }
  })
})

describe('mobileModuleLoader HostPort reentrancy', () => {
  it('immediately rejects a public loader call made by synchronous readModule', async () => {
    const entryUrl = `${APP_ROOT}entry.mjs`
    let loader!: HolonomyModuleLoader
    let reentrantOutcome: Promise<unknown> | undefined
    const port: HostModuleLoaderPort = {
      readModule(canonicalUrl) {
        if (canonicalUrl !== entryUrl) return null
        reentrantOutcome = loader.resolve('./nested.mjs').then(
          () => undefined,
          (error: unknown) => error
        )
        return hostSource('export const entry = true')
      },
      syntheticNodeModules: {}
    }
    loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    await expect(loader.createPlan('./entry.mjs')).resolves.toBeDefined()
    await expect(reentrantOutcome).resolves.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL'
    })
  })

  it('preserves the stable reentrant error from an async readModule before its first await', async () => {
    let loader!: HolonomyModuleLoader
    const port: HostModuleLoaderPort = {
      async readModule() {
        await loader.resolve('./nested.mjs')
        return hostSource('export const unreachable = true')
      },
      syntheticNodeModules: {}
    }
    loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    await expect(loader.createPlan('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL'
    })
  })

  it('provides a deterministic non-reentrant facade across HostPort await boundaries', async () => {
    const port: HostModuleLoaderPort = {
      async readModule(_canonicalUrl, context) {
        await Promise.resolve()
        await context.loader.resolve('./nested.mjs')
        return hostSource('export const unreachable = true')
      },
      syntheticNodeModules: {}
    }
    const loader = new HolonomyModuleLoader(port, { rootUrl: APP_ROOT })

    await expect(loader.createPlan('./entry.mjs')).rejects.toMatchObject({
      code: 'ERR_HOLONOMY_MODULE_REENTRANT_HOST_CALL'
    })
  })
})

describe('mobileModuleLoader strict limit snapshots', () => {
  const construct = (limits: Partial<HolonomyModuleLoaderOptions['limits']> | unknown) =>
    new HolonomyModuleLoader({
      readModule: () => null,
      syntheticNodeModules: {}
    }, {
      limits: limits as HolonomyModuleLoaderOptions['limits'],
      rootUrl: APP_ROOT
    })

  it('publishes exactly six frozen own data fields', () => {
    const loader = construct({ maxModules: 12 })

    expect(Object.keys(loader.limits)).toEqual([
      'maxAstDepth',
      'maxAstNodes',
      'maxDependenciesPerModule',
      'maxModules',
      'maxSourceBytes',
      'maxTotalSourceBytesPerPlan'
    ])
    expect(Object.isFrozen(loader.limits)).toBe(true)
    expect(loader.limits.maxModules).toBe(12)
  })

  it('rejects accessors without invoking their getter', () => {
    let getterCalls = 0
    const limits = {}
    Object.defineProperty(limits, 'maxSourceBytes', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('getter must not run')
      }
    })

    expect(() => construct(limits)).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    }))
    expect(getterCalls).toBe(0)
  })

  it('rejects unknown, symbol and non-enumerable properties', () => {
    expect(() => construct({ unknownLimit: 1 })).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    }))
    expect(() => construct({ [Symbol('limit')]: 1 })).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    }))
    const nonEnumerable = {}
    Object.defineProperty(nonEnumerable, 'maxModules', { value: 1 })
    expect(() => construct(nonEnumerable)).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    }))
  })

  it('rejects custom/null prototypes and exceptional proxies with one stable code', () => {
    expect(() => construct(Object.create({ maxModules: 1 }))).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    }))
    expect(() => construct(Object.create(null))).toThrowError(expect.objectContaining({
      code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED'
    }))

    for (
      const limits of [
        new Proxy({}, {
          getPrototypeOf() {
            throw new Error('native proxy prototype detail')
          }
        }),
        new Proxy({}, {
          ownKeys() {
            throw new Error('native proxy ownKeys detail')
          }
        })
      ]
    ) {
      let thrown: unknown
      try {
        construct(limits)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toMatchObject({ code: 'ERR_HOLONOMY_MODULE_RESOURCE_EXHAUSTED' })
      expect(String(thrown)).not.toContain('native proxy')
    }
  })
})
