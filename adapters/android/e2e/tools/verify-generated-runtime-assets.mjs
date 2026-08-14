import { Buffer } from 'node:buffer'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { verifyRuntimeAssets } from './verify-runtime-assets.mjs'

export const verifyGeneratedRuntimeAssets = (manifest, outputRoot) => {
  verifyRuntimeAssets(manifest, outputRoot)
  const stalePath = resolve(outputRoot, 'runtime/stale-regression.tmp')
  writeFileSync(stalePath, 'stale')
  let rejectedExtra = false
  try {
    verifyRuntimeAssets(manifest, outputRoot)
  } catch {
    rejectedExtra = true
  }
  rmSync(stalePath)
  if (!rejectedExtra) throw new Error('Extra asset regression was not rejected')

  const digestTarget = resolve(outputRoot, manifest.assets[0].path)
  const original = readFileSync(digestTarget)
  writeFileSync(digestTarget, Buffer.concat([original, Buffer.from('stale')]))
  let rejectedStale = false
  try {
    verifyRuntimeAssets(manifest, outputRoot)
  } catch {
    rejectedStale = true
  }
  writeFileSync(digestTarget, original)
  if (!rejectedStale) throw new Error('Stale asset regression was not rejected')
  verifyRuntimeAssets(manifest, outputRoot)

  if (statSync(resolve(outputRoot, 'runtime/asset-manifest.json')).size === 0) {
    throw new Error('Generated runtime asset manifest is empty')
  }
}
