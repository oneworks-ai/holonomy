package ai.oneworks.holonomy.capability

import android.content.Context
import android.os.SystemClock
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

internal class AndroidDeviceProvider(
    context: Context,
    private val generation: Long,
    descriptor: JSONObject,
    private val resources: CapabilityResourceStore,
) {
    private val values = AndroidDeviceValues(context)
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
        val bindingId = "android-device-${nextBinding.getAndIncrement()}"
        val subscription = AndroidDeviceSubscriptionResource(kinds, values)
        resources.publish(bindingId, subscription)
        return success(
            JSONObject()
                .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
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
) : EventCapabilityResource() {
    private val nextSequence = AtomicLong(1)

    override fun onSubscribed(sink: RuntimeCapabilityResourceEventSink) {
        for (kind in kinds.sorted()) {
            val reading = values.readingForEvent(kind)
            sink.emit(
                JSONObject()
                    .put("kind", kind)
                    .put("observedAt", SystemClock.elapsedRealtime())
                    .put("phase", "snapshot")
                    .put("reading", reading)
                    .put("schemaVersion", 1)
                    .put("sequence", nextSequence.getAndIncrement())
                    .toString(),
            )
        }
    }

    override fun closeResource() = Unit
}
