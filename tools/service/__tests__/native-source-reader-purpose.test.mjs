import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it as test } from 'vitest'

import { createNativeSourceReader } from '../../holonomy-native-source-reader.mjs'

const withHelper = async (mode, run) => {
  const root = await mkdtemp(join(tmpdir(), 'holo-source-purpose-'))
  const executable = join(root, 'helper.mjs')
  const script = `#!/usr/bin/env node
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
const mode = ${JSON.stringify(mode)}
const bytes = Buffer.alloc(mode === 'large' || mode === 'malformed' ? 8 * 1024 * 1024 : 2, 65)
const base64 = bytes.toString('base64')
const sha256 = createHash('sha256').update(bytes).digest('hex')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  for (let end; (end = input.indexOf('\\n')) >= 0;) {
    const request = JSON.parse(input.slice(0, end))
    input = input.slice(end + 1)
    let value = null
    if (request.op === 'init') value = { rootUrl: 'app://workspace/' }
    if (request.op === 'seal' || request.op === 'close') value = true
    if (request.op === 'readGuestResource') {
      value = {
        base64: mode === 'malformed' ? base64.slice(0, -1) + '!' : base64,
        sha256,
        canonicalUrl: request.url,
        ...(mode === 'bare-query' || mode === 'bare-fragment' ? { metadataOnly: true } : {})
      }
    }
    process.stdout.write(JSON.stringify({ schemaVersion: 1, id: request.id, ok: true, value }) + '\\n')
  }
})
`
  await writeFile(executable, script, { mode: 0o700 })
  let reader
  try {
    reader = await createNativeSourceReader({ binaryPath: executable, workspaceRoot: root })
    await reader.seal()
    await run(reader)
  } finally {
    await reader?.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('the maximum bounded source response decodes without regex stack growth', async () => {
  await withHelper('large', async reader => {
    const resource = await reader.readGuestResource('app://workspace/large.mjs')
    assert.equal(resource.bytes.byteLength, 8 * 1024 * 1024)
  })
})

test('malformed bounded base64 is rejected by canonical re-encoding', async () => {
  await withHelper('malformed', async reader => {
    await assert.rejects(reader.readGuestResource('app://workspace/large.mjs'), {
      code: 'invalid_response'
    })
  })
})

test('metadataOnly cannot use an empty query or fragment delimiter', async () => {
  for (const [mode, suffix] of [['bare-query', '?'], ['bare-fragment', '#']]) {
    await withHelper(mode, async reader => {
      await assert.rejects(
        reader.readGuestResource(`app://workspace/package.json${suffix}`, 'packageMetadata'),
        { code: 'invalid_response' }
      )
    })
  }
})
