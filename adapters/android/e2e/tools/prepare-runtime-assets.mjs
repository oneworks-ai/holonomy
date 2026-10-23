import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { prepareRuntimeAssets } from '../../runtime-host/tools/asset-packager.mjs'
import {
  generateCapabilityFilesystemGenerationFixture,
  generateCapabilityKernelFixture,
  generateCapabilityNetworkContinuationFixture,
  generateCapabilityNetworkPrivateDenyFixture,
  generateCapabilityNetworkRealFixture
} from './generate-capability-kernel-fixture.mjs'
import { generateProcessBackendProbe } from './generate-process-backend-probe.mjs'

const [compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot] = process.argv.slice(2)
if ([compiledRoot, sourceRoot, bootstrapRoot, fixtureRoot, acornPath, outputRoot].some(value => value == null)) {
  throw new Error('prepare-runtime-assets requires six paths')
}
void prepareRuntimeAssets({
  compiledRoot,
  sourceRoot,
  bootstrapRoot,
  acornPath,
  outputRoot,
  fallbackBootstrapRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../../runtime-host/src/runtimeBootstrap'),
  extend: async ({ recordAsset, recordGeneratedAsset }) => {
    recordAsset(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../runtime-host/src/runtimeBootstrap/bootstrap.mjs'),
      'runtime/production-bootstrap.mjs',
      'bootstrap',
      false,
      'adapters/android/runtime-host/src/runtimeBootstrap/bootstrap.mjs'
    )
    recordAsset(
      resolve(dirname(bootstrapRoot), 'backendProbe/v86-probe.mjs'),
      'runtime/process-backends/v86/probe.mjs',
      'backend-probe',
      false,
      'adapters/android/e2e/src/backendProbe/v86-probe.mjs'
    )
    recordAsset(resolve(fixtureRoot, 'managed-plugin.mjs'), 'runtime/fixtures/managed-plugin.mjs', 'fixture', true)
    recordGeneratedAsset(generateProcessBackendProbe(), 'backend-probe')
    for (
      const generate of [
        generateCapabilityKernelFixture,
        generateCapabilityFilesystemGenerationFixture,
        generateCapabilityNetworkContinuationFixture,
        generateCapabilityNetworkPrivateDenyFixture,
        generateCapabilityNetworkRealFixture
      ]
    ) recordGeneratedAsset(await generate(), 'contract-fixture')
  }
})
