package ai.oneworks.holonomy.capability

import android.os.SystemClock
import org.json.JSONObject

internal class AndroidDeviceValues(private val source: AndroidDeviceValueSource) {
    private val states = mutableMapOf<String, ReadingState>()

    fun reading(operation: String): JSONObject {
        return reading(operation, source.value(operation))
    }

    fun summary(): JSONObject = JSONObject()
        .put("display", reading("device.display.read"))
        .put("formFactor", reading("device.form-factor.read"))
        .put("input", reading("device.input.read"))
        .put("lifecycle", reading("device.lifecycle.read"))
        .put("power", reading("device.power.read"))
        .put("schemaVersion", 1)

    fun readingForEvent(kind: String): JSONObject = reading(
        when (kind) {
            "connectivity" -> "device.connectivity.read"
            "display" -> "device.display.read"
            "lifecycle" -> "device.lifecycle.read"
            "power" -> "device.power.read"
            else -> throw ProviderFailure("argument.invalid")
        },
    )

    @Synchronized
    private fun reading(operation: String, value: Any): JSONObject {
        val signature = JSONObject()
            .put("precision", "standard")
            .put("status", "available")
            .put("value", value)
            .toString()
        val previous = states[operation]
        val revision = when {
            previous == null -> 1
            previous.signature == signature -> previous.revision
            previous.revision >= MAX_SAFE_REVISION -> throw ProviderFailure("provider.protocol_error")
            else -> previous.revision + 1
        }
        states[operation] = ReadingState(revision, signature)
        return JSONObject(signature)
            .put("observedAt", SystemClock.elapsedRealtime())
            .put("revision", revision)
    }

    private data class ReadingState(val revision: Long, val signature: String)

    private companion object {
        const val MAX_SAFE_REVISION = 9_007_199_254_740_991L
    }
}
