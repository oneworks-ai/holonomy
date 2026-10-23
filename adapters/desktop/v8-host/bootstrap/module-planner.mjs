import {
  HolonomyModuleLoader,
  HolonomyModuleLoaderError
} from '../../../../packages/runtime/src/module-loader/index.ts'
import { RuntimeTextDecoder, RuntimeURL, RuntimeURLSearchParams } from '../../../node/src/runtime-web-standards.mjs'

const native = globalThis.__holoModulePlannerHost
delete globalThis.__holoModulePlannerHost
globalThis.URL = RuntimeURL
globalThis.URLSearchParams = RuntimeURLSearchParams
globalThis.TextDecoder = RuntimeTextDecoder

// Runs only in the private planner Context; no object from this Context crosses
// into Guest code. Reuse the shared resolver rather than trusting Guest JSON.
export const create = encoded => {
  const loader = new HolonomyModuleLoader({
    syntheticNodeModules: JSON.parse(encoded),
    readModule(url, context) {
      const text = native.readModule(url, context?.purpose ?? 'module')
      if (text === null) return null
      const value = JSON.parse(text)
      return {
        bytes: new Uint8Array(value.bytes),
        sha256: value.sha256,
        canonicalUrl: value.canonicalUrl,
        ...(value.metadataOnly === true ? { metadataOnly: true } : {})
      }
    }
  }, { rootUrl: 'app://workspace/', allowJsonModules: true })
  return Object.freeze({
    async plan(specifier, parentUrl) {
      try {
        return JSON.stringify(await loader.createPlan(specifier, parentUrl === '' ? {} : { parentUrl }))
      } catch (error) {
        // Private Error/Function/prototype references must never reach Guest.
        throw error instanceof HolonomyModuleLoaderError
          ? error.code
          : 'ERR_HOLONOMY_MODULE_PLAN_FAILED'
      }
    }
  })
}
