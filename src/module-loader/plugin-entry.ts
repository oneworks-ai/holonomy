import { MobileModuleLoaderError } from './errors.js'
import type { PluginActivate } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value != null && (typeof value === 'object' || typeof value === 'function')
)

/** Selects the only two supported plugin-manager activation shapes. */
export const selectPluginActivate = (moduleNamespace: unknown): PluginActivate => {
  if (isRecord(moduleNamespace) && typeof moduleNamespace.activatePlugin === 'function') {
    return moduleNamespace.activatePlugin as PluginActivate
  }
  const defaultExport = isRecord(moduleNamespace) ? moduleNamespace.default : undefined
  if (isRecord(defaultExport) && typeof defaultExport.activatePlugin === 'function') {
    return defaultExport.activatePlugin as PluginActivate
  }
  throw new MobileModuleLoaderError(
    'ERR_MOBILE_MODULE_PLUGIN_ENTRY_INVALID',
    'Plugin entry must export activatePlugin or default.activatePlugin'
  )
}
