import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { createNativeSourceReader } from '../../holonomy-native-source-reader.mjs'

const requested = 'app://workspace/node_modules/pkg/index.mjs?case=one'
const canonical = 'app://workspace/node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs?case=one'
const bytes = Buffer.from('export default 42')
const legacy = { base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
const resource = { ...legacy, canonicalUrl: canonical }

const withReader = async (response, run) => {
  const root = await mkdtemp(join(tmpdir(), 'holo-reader-resource-'))
  const executable = join(root, 'helper.mjs')
  const script = `#!/usr/bin/env node
let input = ''
const resource = ${JSON.stringify(response)}
const legacy = ${JSON.stringify(legacy)}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  for (let end; (end = input.indexOf('\\n')) >= 0;) {
    const request = JSON.parse(input.slice(0, end))
    input = input.slice(end + 1)
    const value = request.op === 'init' ? { rootUrl: 'app://workspace/' }
      : request.op === 'readGuestResource' ? resource
      : request.op === 'readGuest' ? legacy
      : request.op === 'close' ? true : undefined
    process.stdout.write(JSON.stringify({ schemaVersion: 1, id: request.id, ok: true, value }) + '\\n')
  }
})
`
  await writeFile(executable, script, { mode: 0o700 })
  let reader
  try {
    reader = await createNativeSourceReader({ binaryPath: executable, workspaceRoot: root })
    return await run(reader)
  } finally {
    await reader?.close()
    await rm(root, { recursive: true, force: true })
  }
}

describe('native source reader resource response', () => {
  it('returns pinned bytes and canonical URL while the legacy operation stays compatible', async () => {
    await withReader(resource, async reader => {
      assert.deepEqual(await reader.readGuestResource(requested), {
        bytes,
        canonicalUrl: canonical,
        sha256: legacy.sha256
      })
      assert.deepEqual(await reader.readGuest(requested), { bytes, sha256: legacy.sha256 })
    })
    await withReader(null, async reader => {
      assert.equal(await reader.readGuestResource(requested), null)
    })
    await withReader({ ...resource, canonicalUrl: `${canonical}#` }, async reader => {
      assert.equal((await reader.readGuestResource(`${requested}#`)).canonicalUrl, `${canonical}#`)
    })
  })

  it.each([
    ['digest mismatch', { ...resource, sha256: '0'.repeat(64) }],
    ['unknown field', { ...resource, extra: true }],
    ['missing digest', { base64: resource.base64, canonicalUrl: canonical }],
    ['wrong root', { ...resource, canonicalUrl: 'file:///private/index.mjs?case=one' }],
    ['extra fragment', { ...resource, canonicalUrl: `${canonical}#fragment` }],
    ['wrong query', { ...resource, canonicalUrl: canonical.replace('case=one', 'case=two') }],
    ['empty fragment mismatch', { ...resource, canonicalUrl: `${canonical}#` }],
    ['encoded separator', { ...resource, canonicalUrl: 'app://workspace/node_modules/%2fpkg/index.mjs?case=one' }],
    ['malformed base64', { ...resource, base64: '%%%invalid%%%' }]
  ])('fails closed for %s', async (_name, response) => {
    await withReader(response, async reader => {
      await assert.rejects(
        reader.readGuestResource(requested),
        error => error.code === 'invalid_response'
      )
    })
  })
})
