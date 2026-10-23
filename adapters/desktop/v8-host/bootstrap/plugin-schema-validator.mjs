import { validateRuntimePluginConfig } from '../../../../tools/runtime-plugin-config-validator.mjs'

export const validate = encoded => {
  try {
    const candidates = JSON.parse(encoded)
    if (!Array.isArray(candidates)) return false
    for (const candidate of candidates) {
      if (
        candidate == null || typeof candidate !== 'object' || Array.isArray(candidate) ||
        Object.keys(candidate).some(key => key !== 'config' && key !== 'schema') ||
        !Object.hasOwn(candidate, 'config') || !Object.hasOwn(candidate, 'schema')
      ) return false
      validateRuntimePluginConfig(candidate.schema, candidate.config)
    }
    return true
  } catch {
    return false
  }
}
