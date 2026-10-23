/* eslint-disable antfu/no-top-level-await -- One-shot artifact audit command. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { verifyNativeProvenance } from './provenance.mjs'

const [directory, extra] = process.argv.slice(2)
if (directory == null || extra != null) {
  throw new Error('Usage: node tools/native-release/verify-provenance.mjs <extracted-bundle-directory>')
}
const bundle = resolve(directory)
const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
const inventory = await verifyNativeProvenance({ bundle, manifest })
process.stdout.write(`${JSON.stringify({ verified: true, ...inventory })}\n`)
