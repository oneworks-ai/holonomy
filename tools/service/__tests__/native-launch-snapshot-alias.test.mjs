import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, vi } from 'vitest'

import {
  getHolonomyNativeSourceContext,
  prepareHolonomyNativeLaunchSnapshot
} from '../../holonomy-native-launch-snapshot.mjs'

const state = vi.hoisted(() => ({ closure: undefined, events: [], home: '', reads: [], purposes: [] }))

vi.mock('@holonomyjs/runtime/module-loader/index', () => ({
  HolonomyModuleLoader: class {
    constructor(port) {
      this.port = port
    }

    async createSourceClosure() {
      await this.port.readModule(state.closure.aliases[0].url, state.closure.readContext)
      return state.closure
    }
  }
}))

const rootUrl = 'app://workspace/'
const entryUrl = `${rootUrl}index.mjs`
const requested = `${rootUrl}node_modules/pkg/index.mjs?case=one`
const canonical = `${rootUrl}node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs?case=one`
const maxSource = 'x'.repeat(8 * 1024 * 1024)
const row = (url, source) => {
  const bytes = Buffer.from(source)
  return {
    byteLength: bytes.length,
    bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    url
  }
}

const withSnapshot = async (aliases, run, configure = () => {}) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'holo-snapshot-alias-')))
  const home = join(cwd, 'home')
  const executable = join(cwd, 'host-reader')
  await mkdir(home)
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await writeFile(join(cwd, 'index.mjs'), `import ${JSON.stringify(requested)}`)
  state.closure = {
    aliases,
    entryUrl,
    externalReferences: [],
    kind: 'source-closure',
    reads: [row(entryUrl, `import ${JSON.stringify(requested)}`), row(canonical, 'export default 42')],
    rootUrl
  }
  configure(state.closure)
  state.reads = []
  state.purposes = []
  state.events = []
  state.home = home
  const reader = {
    reservePrivateDirectory: async directory => state.events.push(`reserve:${directory}`),
    capturePrivate: async file => {
      state.events.push(`capture:${file}`)
      return { kind: 'file' }
    },
    close: async () => {},
    readGuest: async () => assert.fail('Legacy source operation was called'),
    readGuestResource: async (url, purpose) => {
      state.events.push(`guest:${url}`)
      state.reads.push(url)
      state.purposes.push(purpose)
      return {
        bytes: Buffer.from('export default 42'),
        canonicalUrl: aliases[0].canonicalUrl,
        sha256: row(canonical, 'export default 42').sha256
      }
    },
    seal: async () => {}
  }
  try {
    const snapshot = await prepareHolonomyNativeLaunchSnapshot('run', {
      argv: [],
      entries: [join(cwd, 'index.mjs')],
      env: {},
      isolation: 'runtime',
      pluginRoots: [],
      reporter: 'tap',
      rootUrl
    }, {
      createNativeSourceReader: async () => reader,
      cwd,
      home,
      nativeSourceExecutablePath: executable
    })
    return await run(snapshot)
  } finally {
    await reader.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

describe('native launch snapshot alias projection', () => {
  it('accepts an exact maximum-sized canonical source row', async () => {
    await withSnapshot([{ url: requested, canonicalUrl: canonical }], snapshot => {
      assert.equal(snapshot.launch.modules.find(module => module.url === entryUrl).source.length, maxSource.length)
    }, closure => {
      closure.reads[0] = row(entryUrl, maxSource)
    })
  })

  it('rejects malformed maximum-sized Base64 without evaluating an unbounded pattern', async () => {
    await assert.rejects(
      withSnapshot([{ url: requested, canonicalUrl: canonical }], () => {}, closure => {
        const damaged = row(entryUrl, maxSource)
        damaged.bytesBase64 = `${damaged.bytesBase64.slice(0, -2)}!${damaged.bytesBase64.slice(-1)}`
        closure.reads[0] = damaged
      }),
      /Native source closure (changed|invalid)/u
    )
  })

  it('reserves the complete managed home before owner-file capture or Guest reads', async () => {
    await withSnapshot([{ url: requested, canonicalUrl: canonical }], () => {
      const reserved = state.events.indexOf(`reserve:${state.home}`)
      const homeCapture = state.events.findIndex(event => event.startsWith(`capture:${state.home}/`))
      const guestRead = state.events.findIndex(event => event.startsWith('guest:'))
      assert(reserved >= 0)
      assert(homeCapture > reserved)
      assert(guestRead > reserved)
    })
  })

  it('forwards the package metadata read purpose and retains the restricted closure fact', async () => {
    const manifestUrl = `${rootUrl}package.json`
    await withSnapshot([{ url: requested, canonicalUrl: canonical }], snapshot => {
      assert.deepEqual(state.purposes, ['packageMetadata'])
      assert.deepEqual(snapshot.launch.modules.find(module => module.url === manifestUrl), {
        metadataOnly: true,
        source: '{"type":"module"}',
        url: manifestUrl
      })
    }, closure => {
      closure.readContext = { purpose: 'packageMetadata' }
      closure.reads.push({ ...row(manifestUrl, '{"type":"module"}'), metadataOnly: true })
    })
  })

  it('rejects a restricted source that is not a queryless package manifest', async () => {
    await assert.rejects(
      withSnapshot([{ url: requested, canonicalUrl: canonical }], () => {}, closure => {
        closure.reads.push({ ...row(`${rootUrl}package.json?raw`, '{}'), metadataOnly: true })
      }),
      /metadata-only source/u
    )
  })

  it('rejects a restricted manifest repeated as an unrestricted physical read', async () => {
    await assert.rejects(
      withSnapshot([{ url: requested, canonicalUrl: canonical }], () => {}, closure => {
        closure.reads.push({ ...row(`${rootUrl}package.json`, '{}'), metadataOnly: true })
        closure.reads.push(row(`${rootUrl}package.json?raw`, '{}'))
      }),
      /source changed during preparation/u
    )
  })

  it('publishes canonical reads and bounded aliases from one source closure', async () => {
    await withSnapshot([{ url: requested, canonicalUrl: canonical }], snapshot => {
      assert.deepEqual(state.reads, [requested])
      assert.deepEqual(snapshot.launch.moduleAliases, [{ url: requested, canonicalUrl: canonical }])
      assert(snapshot.launch.modules.some(module => module.url === canonical))
      assert(!snapshot.launch.modules.some(module => module.url === requested))
      assert(getHolonomyNativeSourceContext(snapshot)?.reader)
    })
  })

  it('rejects aliases whose canonical target was not positively read', async () => {
    await assert.rejects(
      withSnapshot([{ url: requested, canonicalUrl: `${rootUrl}unread.mjs?case=one` }], () => {}),
      /alias target is invalid/u
    )
  })

  it('uses the canonical entry for launch and argv when an explicit entry crosses a package link', async () => {
    const canonicalEntry = `${rootUrl}node_modules/.pnpm/pkg@1/node_modules/pkg/entry.mjs`
    for (const closureEntry of [entryUrl, canonicalEntry]) {
      await withSnapshot([{ url: entryUrl, canonicalUrl: canonicalEntry }], snapshot => {
        assert.equal(snapshot.entryUrl, canonicalEntry)
        assert.equal(snapshot.launch.entryUrl, canonicalEntry)
        assert.equal(snapshot.launch.argv[0], canonicalEntry)
        assert.deepEqual(snapshot.launch.modules, [{ source: 'export default 42', url: canonicalEntry }])
        assert.deepEqual(snapshot.launch.moduleAliases, [{ url: entryUrl, canonicalUrl: canonicalEntry }])
      }, closure => {
        closure.entryUrl = closureEntry
        closure.reads = [row(canonicalEntry, 'export default 42')]
      })
    }
  })
})
