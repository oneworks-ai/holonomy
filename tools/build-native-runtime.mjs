/* eslint-disable antfu/no-top-level-await -- Sequential build entry; no runtime dependency on Node. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = new URL('../', import.meta.url)
for (
  const [entry, name, exported] of [
    ['main', 'runtime', 'ready'],
    ['control', 'control', 'control'],
    ['plugin-schema-validator', 'plugin-validator', 'validate'],
    ['module-planner', 'module-planner', 'create']
  ]
) {
  const output = new URL(`adapters/desktop/v8-host/generated/${name}.js`, root)
  await mkdir(new URL('.', output), { recursive: true })
  const bundle = await build({
    absWorkingDir: fileURLToPath(root),
    bundle: true,
    conditions: ['__oneworks__'],
    entryPoints: [`adapters/desktop/v8-host/bootstrap/${entry}.mjs`],
    format: 'iife',
    globalName: '__holoBootstrap',
    legalComments: 'eof',
    outfile: fileURLToPath(output),
    platform: 'neutral',
    target: 'es2022',
    write: false
  })
  // Keep the bundle export and its private Host controller in a local closure.
  await writeFile(output, `(() => {\n${bundle.outputFiles[0].text}\nreturn __holoBootstrap.${exported};\n})()`)
  const source = await readFile(output)
  await writeFile(new URL(`${name}.sha256`, output), createHash('sha256').update(source).digest('hex'))
  process.stdout.write(`Native Runtime asset: ${source.length} bytes\n`)
}

// The v86 VM uses only these portable Web leaves, in its own private isolate.
// Keep this asset separate from the Host and Guest Runtime bundles.
{
  const output = new URL('adapters/desktop/v8-host/generated/v86-web-standards.js', root)
  const bundle = await build({
    absWorkingDir: fileURLToPath(root),
    bundle: true,
    entryPoints: ['adapters/desktop/v8-host/bootstrap/v86-web-standards.mjs'],
    format: 'iife',
    legalComments: 'eof',
    outfile: fileURLToPath(output),
    platform: 'neutral',
    target: 'es2022',
    write: false
  })
  const source = bundle.outputFiles[0].contents
  await writeFile(output, source)
  await writeFile(new URL('v86-web-standards.sha256', output), createHash('sha256').update(source).digest('hex'))
  process.stdout.write(`Native v86 Web leaves: ${source.length} bytes\n`)
}
