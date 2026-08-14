package ai.oneworks.holonomy.capability

import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicBoolean

internal interface AndroidCapabilityResource : AutoCloseable {
    fun subscribe(sink: RuntimeCapabilityResourceEventSink): AutoCloseable? = null
}

internal abstract class EventCapabilityResource : AndroidCapabilityResource {
    private val closed = AtomicBoolean(false)
    private val listeners = CopyOnWriteArraySet<RuntimeCapabilityResourceEventSink>()

    final override fun subscribe(sink: RuntimeCapabilityResourceEventSink): AutoCloseable? {
        if (closed.get()) return null
        listeners += sink
        onSubscribed(sink)
        return AutoCloseable { listeners -= sink }
    }

    protected fun emit(source: String) {
        if (!closed.get()) listeners.forEach { listener -> runCatching { listener.emit(source) } }
    }

    protected open fun onSubscribed(sink: RuntimeCapabilityResourceEventSink) = Unit

    final override fun close() {
        if (!closed.compareAndSet(false, true)) return
        listeners.clear()
        closeResource()
    }

    protected abstract fun closeResource()
}

internal class CapabilityResourceStore : AutoCloseable {
    private val resources = ConcurrentHashMap<String, AndroidCapabilityResource>()

    fun publish(bindingId: String, resource: AndroidCapabilityResource) {
        if (resources.putIfAbsent(bindingId, resource) != null) {
            resource.close()
            throw ProviderFailure("provider.protocol_error")
        }
    }

    fun require(bindingId: String): AndroidCapabilityResource =
        resources[bindingId] ?: throw ProviderFailure("resource.stale")

    fun release(bindingId: String) {
        resources.remove(bindingId)?.close()
    }

    fun subscribe(bindingId: String, sink: RuntimeCapabilityResourceEventSink): AutoCloseable? =
        require(bindingId).subscribe(sink)

    override fun close() {
        val snapshot = resources.values.toList()
        resources.clear()
        snapshot.forEach { resource -> runCatching { resource.close() } }
    }
}
