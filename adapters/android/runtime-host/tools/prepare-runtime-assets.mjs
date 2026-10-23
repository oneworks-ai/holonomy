import process from 'node:process'
import { prepareRuntimeAssets } from './asset-packager.mjs'

const [compiledRoot, sourceRoot, bootstrapRoot, acornPath, outputRoot] = process.argv.slice(2)
if ([compiledRoot, sourceRoot, bootstrapRoot, acornPath, outputRoot].some(value => value == null)) {
  throw new Error('prepare-runtime-assets requires five paths')
}
void prepareRuntimeAssets({ compiledRoot, sourceRoot, bootstrapRoot, acornPath, outputRoot })
