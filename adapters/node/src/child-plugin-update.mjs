import { normalizeNodeRuntimePluginUpdateV1 } from './capability-runtime-plugins.mjs'

export const applyNodeRuntimePluginUpdateV1 = async (command, currentRevision, hostController) => {
  const expectedRevision = command.value?.expectedRevision
  const revision = command.value?.revision
  if (
    !Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(revision) ||
    expectedRevision !== currentRevision || revision !== expectedRevision + 1
  ) return Object.freeze({ error: 'invalid_plugin_revision' })
  try {
    const runtimePlugins = normalizeNodeRuntimePluginUpdateV1(command.value.runtimePlugins)
    await hostController?.updatePlugins(runtimePlugins, expectedRevision, revision)
    return Object.freeze({ revision })
  } catch {
    return Object.freeze({ error: 'invalid_plugins' })
  }
}
