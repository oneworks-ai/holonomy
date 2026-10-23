/* eslint-disable antfu/no-top-level-await -- One-shot development packaging command. */
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { packageNativeRuntime } from './native-release/package.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const options = { root, binary: resolve(root, 'target/release/holo'), output: resolve(root, 'target/native-artifact') }
try {
  const seen = new Set()
  while (args.length > 0) {
    const key = args.shift()
    if (key === '--v86-cat-smoke' && !seen.has(key)) {
      seen.add(key)
      options.v86CatSmoke = true
      continue
    }
    if (
      !['--binary', '--output', '--v86-assets', '--v86-pins'].includes(key) ||
      seen.has(key) || !args[0] || args[0].startsWith('--')
    ) {
      throw new Error(
        'Usage: package-native-runtime [--binary FILE] [--output NEW_DIRECTORY] [--v86-assets ABS_DIRECTORY --v86-pins OWNER_ONLY_JSON [--v86-cat-smoke]]'
      )
    }
    seen.add(key)
    options[
      {
        '--binary': 'binary',
        '--output': 'output',
        '--v86-assets': 'v86Assets',
        '--v86-pins': 'v86Pins'
      }[key]
    ] = resolve(args.shift())
  }
  process.stdout.write(`${JSON.stringify(await packageNativeRuntime(options), null, 2)}\n`)
} catch (error) {
  process.stderr.write(`Native package: ${error.message}\n`)
  process.exitCode = 1
}
