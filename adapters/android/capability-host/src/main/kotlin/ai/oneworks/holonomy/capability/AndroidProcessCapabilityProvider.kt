package ai.oneworks.holonomy.capability

import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink

/** Optional production owner for Android `node:child_process` capability operations. */
interface AndroidProcessCapabilityProvider : AutoCloseable {
    fun invoke(requestJson: String): String

    fun ownsResource(bindingId: String): Boolean

    fun subscribeResource(bindingId: String, sink: RuntimeCapabilityResourceEventSink): AutoCloseable?

    fun releaseResource(bindingId: String)

    override fun close() = Unit
}
