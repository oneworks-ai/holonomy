package ai.oneworks.holonomy.v86

import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal class AndroidV86EventChannel(
    private val maximumBytes: Long,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val events = CopyOnWriteArrayList<String>()
    private val listeners = ConcurrentHashMap<RuntimeCapabilityResourceEventSink, AtomicInteger>()
    @Volatile
    private var paused = false
    private var size = 0L

    @Synchronized
    fun emit(source: String, bytes: Int = 0): Boolean {
        // A released Guest resource intentionally discards later producer
        // events. Only a live channel exceeding its cap is backpressure
        // failure that should terminate the child process.
        if (closed.get()) return true
        if (size + bytes > maximumBytes) return false
        size += bytes
        events += source
        if (!paused) listeners.keys.forEach(::drain)
        return true
    }

    fun pause() {
        paused = true
    }

    fun resume() {
        paused = false
        listeners.keys.forEach(::drain)
    }

    fun subscribe(sink: RuntimeCapabilityResourceEventSink): AutoCloseable {
        listeners[sink] = AtomicInteger(0)
        drain(sink)
        return AutoCloseable { listeners.remove(sink) }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        listeners.clear()
    }

    @Synchronized
    private fun drain(sink: RuntimeCapabilityResourceEventSink) {
        if (paused) return
        val cursor = listeners[sink] ?: return
        while (!paused) {
            val index = cursor.getAndIncrement()
            if (index >= events.size) {
                cursor.decrementAndGet()
                return
            }
            deliver(sink, events[index])
        }
    }

    private fun deliver(sink: RuntimeCapabilityResourceEventSink, source: String) {
        runCatching { sink.emit(source) }
    }
}
