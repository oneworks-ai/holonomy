import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { verifyGeneratedRuntimeAssets } from './verify-generated-runtime-assets.mjs'

export const writeRuntimeAssetManifest = (input, outputRoot) => {
  const manifest = {
    assets: [...input.assets.values()].sort((left, right) => left.path.localeCompare(right.path)),
    moduleAliases: [...input.moduleAliases].sort(([left], [right]) => left.localeCompare(right))
      .map(([specifier, path]) => ({ path, specifier })),
    schemaVersion: 2,
    typescriptSources: [...input.typescriptSources].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, digest]) => ({ path, sha256: digest }))
  }
  writeFileSync(resolve(outputRoot, 'runtime/asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  verifyGeneratedRuntimeAssets(manifest, outputRoot)
}
