package ai.oneworks.holonomy.capability

import android.content.Context
import android.os.SystemClock
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

internal class AndroidDeviceProvider(
    context: Context,
    private val generation: Long,
    descriptor: JSONObject,
    private val resources: CapabilityResourceStore,
    private val observations: AndroidDeviceObservationSource,
    valueSource: AndroidDeviceValueSource? = null,
) {
    private val values = AndroidDeviceValues(valueSource ?: AndroidDeviceValueSource.platform(context))
    private val nextBinding = AtomicLong(1)
    private val supported = descriptor.getJSONArray("operations").objects()
        .associate { item -> item.getString("operation") to item }

    fun invoke(request: JSONObject): String {
        val resource = request.getJSONObject("resource")
        require(resource.getString("kind") == "deviceField")
        val operation = resource.getString("operation")
        requireSupported(operation)
        requireAuthority(request, operation)
        return if (operation == "device.events.subscribe") subscribe(request, resource) else {
            val reading = if (operation == "device.summary.read") values.summary() else values.reading(operation)
            success(reading)
        }
    }

    private fun subscribe(request: JSONObject, resource: JSONObject): String {
        val kinds = request.getJSONObject("arguments").getJSONArray("kinds").strings()
        val allowedKinds = supported.getValue("device.events.subscribe").getJSONArray("eventKinds").strings()
        if (kinds.isEmpty() || !allowedKinds.containsAll(kinds)) throw ProviderFailure("capability.denied")
        val maxQueuedEvents = request.getJSONArray("authorityBindings").objects()
            .filter { binding -> binding.getString("providerModule") == "host.device" }
            .map { binding -> binding.getJSONObject("constraints").getInt("maxQueuedEvents") }
            .minOrNull()
            ?.takeIf { value -> value >= 1 }
            ?: throw ProviderFailure("capability.denied")
        val bindingId = "android-device-${nextBinding.getAndIncrement()}"
        val subscription = AndroidDeviceSubscriptionResource(kinds, values, observations)
        resources.publish(bindingId, subscription)
        return success(
            JSONObject()
                .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
                .put("maxQueuedEvents", maxQueuedEvents)
                .put("resourceType", "device.subscription")
                .put("startSequence", 0),
            listOf(resourcePublication(bindingId, "device.subscription", "HoloDeviceEventV1")),
        )
    }

    private fun requireSupported(operation: String) {
        val support = supported[operation]?.getString("supportLevel")
        if (support == null || support == "unsupported") throw ProviderFailure("provider.unavailable")
    }

    private fun requireAuthority(request: JSONObject, operation: String) {
        val authorized = request.getJSONArray("authorityBindings").objects().any { binding ->
            binding.getString("providerModule") == "host.device" &&
                binding.getJSONObject("constraints").getJSONArray("operations").strings().contains(operation)
        }
        if (!authorized) throw ProviderFailure("capability.denied")
    }
}

private class AndroidDeviceSubscriptionResource(
    private val kinds: List<String>,
    private val values: AndroidDeviceValues,
    private val observations: AndroidDeviceObservationSource,
) : EventCapabilityResource() {
    private val closed = AtomicBoolean(false)
    private val lastRevisions = ConcurrentHashMap<String, Long>()
    private val nextSequence = AtomicLong(1)
    private val started = AtomicBoolean(false)
    @Volatile private var observationSubscription: AutoCloseable? = null

    override fun onSubscribed(sink: RuntimeCapabilityResourceEventSink) {
        for (kind in kinds.sorted()) {
            val reading = values.readingForEvent(kind)
            lastRevisions[kind] = reading.getLong("revision")
            sink.emit(
                event(kind, "snapshot", reading).toString(),
            )
        }
        if (started.compareAndSet(false, true)) {
            observationSubscription = observations.subscribe(kinds.toSet(), ::emitChange)
            for (kind in kinds.sorted()) emitChange(kind)
        }
    }

    private fun emitChange(kind: String) {
        if (closed.get() || kind !in kinds) return
        val reading = values.readingForEvent(kind)
        val revision = reading.getLong("revision")
        val previous = lastRevisions.put(kind, revision)
        if (previous != null && revision <= previous) return
        emit(event(kind, "change", reading).toString())
    }

    private fun event(kind: String, phase: String, reading: JSONObject) = JSONObject()
        .put("kind", kind)
        .put("observedAt", SystemClock.elapsedRealtime())
        .put("phase", phase)
        .put("reading", reading)
        .put("schemaVersion", 1)
        .put("sequence", nextSequence.getAndIncrement())

    override fun closeResource() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { observationSubscription?.close() }
        observationSubscription = null
        lastRevisions.clear()
    }
}
