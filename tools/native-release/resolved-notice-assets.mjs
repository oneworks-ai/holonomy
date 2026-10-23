import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ordered = values => [...values].sort((a, b) => a.localeCompare(b, 'en'))
const safePath = value =>
  typeof value === 'string' && value.length > 0 &&
  value.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'))
const assetEntries = Object.freeze([
  ['main', 'runtime', 'ready', 'runtimeAssetSha256'],
  ['control', 'control', 'control', 'hostControlAssetSha256'],
  ['plugin-schema-validator', 'plugin-validator', 'validate', 'pluginValidatorAssetSha256'],
  ['module-planner', 'module-planner', 'create', 'modulePlannerAssetSha256'],
  ['v86-web-standards', 'v86-web-standards', null, null]
])

export const collectEmbeddedInputs = async (root, engine) => {
  const assets = []
  const npm = new Map()
  for (
    const [entry, name, exported, engineKey] of assetEntries
      .filter((_, position) => position < 4 || engine.v86BackendCompiled)
  ) {
    const outfile = resolve(root, `adapters/desktop/v8-host/generated/${name}.js`)
    const options = {
      absWorkingDir: root,
      bundle: true,
      entryPoints: [`adapters/desktop/v8-host/bootstrap/${entry}.mjs`],
      format: 'iife',
      legalComments: 'eof',
      metafile: true,
      outfile,
      platform: 'neutral',
      target: 'es2022',
      write: false,
      ...(exported == null ? {} : { conditions: ['__oneworks__'], globalName: '__holoBootstrap' })
    }
    const output = await build(options)
    const bytes = exported == null
      ? output.outputFiles[0].contents
      : Buffer.from(`(() => {\n${output.outputFiles[0].text}\nreturn __holoBootstrap.${exported};\n})()`)
    const sha256 = digest(bytes)
    if (
      sha256 !== digest(await readFile(outfile)) ||
      sha256 !== (await readFile(`${outfile.slice(0, -3)}.sha256`, 'utf8')).trim() ||
      (engineKey != null && sha256 !== engine[engineKey])
    ) {
      throw new Error(`Native embedded asset input graph differs: ${name}`)
    }
    const inputs = []
    for (const path of ordered(Object.keys(output.metafile.inputs))) {
      if (!safePath(path)) throw new Error('Invalid embedded input path')
      const source = await readFile(join(root, path))
      inputs.push({ path, sha256: digest(source) })
      if (!path.startsWith('node_modules/')) continue
      const match = path.match(/^node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//u)
      if (!match) throw new Error(`Unexpected external embedded input: ${path}`)
      const marker = `/node_modules/${match[1]}/`
      const packageRoot = path.slice(0, path.indexOf(marker) + marker.length - 1)
      const item = npm.get(packageRoot) ?? { root: packageRoot, inputs: new Map(), bundles: new Set() }
      const input = item.inputs.get(path) ?? { sha256: digest(source), bundles: new Set() }
      if (input.sha256 !== digest(source)) throw new Error('Native npm input changed between bundles')
      input.bundles.add(name)
      item.inputs.set(path, input)
      item.bundles.add(name)
      npm.set(packageRoot, item)
    }
    assets.push({ name, sha256, inputs })
  }
  return { assets, npm }
}
