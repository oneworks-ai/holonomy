package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeModuleSource

/** A capability-only Host Realm does not require applications to invent an empty plugin graph. */
internal fun emptyRuntimePluginManifest(
    specifier: String, referrerInternal: Boolean, configuredPlugins: String,
): RuntimeModuleSource? = if (
    referrerInternal && specifier == "holo-plugins:///manifest.mjs" &&
    configuredPlugins.filterNot(Char::isWhitespace) == "[]"
) RuntimeModuleSource(specifier, "export const runtimePluginNamespaces = Object.freeze({});") else null
