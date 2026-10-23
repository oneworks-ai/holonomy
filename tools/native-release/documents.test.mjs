/* eslint-disable test/no-import-node-test -- Build-tool tests run directly without the Runtime test loader. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { NATIVE_BUNDLE_DOCUMENTS } from './documents.mjs'

test('native archive documentation includes every relative guide dependency', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  for (const [destination, source] of Object.entries(NATIVE_BUNDLE_DOCUMENTS)) {
    if (!destination.endsWith('.md')) continue
    const markdown = await readFile(resolve(root, source), 'utf8')
    for (const [, target] of markdown.matchAll(/\]\(([^)]+)\)/gu)) {
      if (/^(?:[a-z]+:|#)/iu.test(target)) continue
      const document = target.split(/[?#]/u)[0]
      assert.ok(Object.hasOwn(NATIVE_BUNDLE_DOCUMENTS, document), `${destination} links to missing ${document}`)
    }
  }
})
