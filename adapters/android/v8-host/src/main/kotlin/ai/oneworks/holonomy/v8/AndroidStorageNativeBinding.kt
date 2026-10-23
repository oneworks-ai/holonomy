package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeAdapterHost
import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

/** Private Host-Realm IO transport. Broker and NativeBridge remain the lifecycle owners. */
internal class AndroidStorageNativeBinding(
    private val native: RuntimeNativeHost,
    capability: RuntimeCapabilityHost?,
    private val runtime: RuntimeAdapterHost,
    private val closed: () -> Boolean,
    private val terminal: (Double, String) -> Unit,
) {
    private val nativeConfiguration = JSONObject(native.configurationJson())
    private val ceiling = capability?.let {
        JSONObject(it.configurationJson()).getJSONObject("session").getJSONObject("runtimeCreation")
            .getJSONObject("configuration").getJSONObject("sandboxPolicy").optJSONObject("storage")
    }

    fun start(id: Double, commandJson: String): Boolean {
        require(id.isFinite() && id > 0 && id <= 9_007_199_254_740_991.0 && id == kotlin.math.floor(id))
        require(commandJson.toByteArray(Charsets.UTF_8).size <= MAX_COMMAND_BYTES)
        val command = JSONObject(commandJson)
        val token = command.getString("callToken")
        require(SCALAR.matches(token))
        val operation = command.getString("operation")
        val args = command.getJSONObject("args")
        val selection = command.getJSONObject("selection")
        requireCeiling(operation, args, selection)
        val binary = decodeBinary(command.optJSONArray("binary"))
        val requestId = "storage-${id.toLong()}"
        val request = JSONObject().put("id", requestId).put("module", "host.storage")
            .put("operation", operation).put("args", args)
        val context = JSONObject().put("callToken", token).put("mode", "result").put("resources", JSONArray())
            .put("authority", JSONObject().put("principal", nativeConfiguration.getString("principal"))
                .put("capabilities", nativeConfiguration.getJSONArray("capabilities")))
            .put("storageSelection", selection)
        if (operation == "v1.kv.set") context.put("storageValue", JSONObject()
            .put("byteLength", command.getLong("valueByteLength")).put("sha256", command.getString("valueSha256")))
        native.dispatch(requestId, request.toString(), context.toString(), binary, RuntimeNativeEventSink { event ->
            val encoded = runCatching {
                require(event.eventJson.toByteArray(Charsets.UTF_8).size <= MAX_COMMAND_BYTES)
                val value = JSONObject(event.eventJson)
                require(value.getString("id") == requestId && value.getString("type") == "result")
                JSONObject().put("value", value.getJSONObject("value"))
                    .put("binary", encodeBinary(event.binary)).toString()
            }.getOrElse { failure("storage.protocol_error") }
            runtime.requestRuntimeTask { if (!closed()) terminal(id, encoded) }
        }, RuntimeNativeResourceEventSink { })
        return true
    }

    fun cancel(token: String) {
        if (SCALAR.matches(token)) native.cancel(token, "cancelled")
    }

    private fun requireCeiling(operation: String, args: JSONObject, selection: JSONObject) {
        val policy = requireNotNull(ceiling) { "Storage policy is unavailable" }
        require(policy.getString("access") == "sandboxed")
        val kernelOperation = when (operation) {
            "v1.kv.get" -> "storage.kv.get"
            "v1.kv.set" -> "storage.kv.set"
            "v1.kv.list" -> "storage.kv.list"
            "v1.kv.delete" -> "storage.kv.delete"
            else -> error("Unsupported storage operation")
        }
        require(selection.getString("namespaceId") == "default" && selection.getString("operation") == kernelOperation)
        val namespaces = policy.getJSONArray("namespaces")
        val namespace = (0 until namespaces.length()).map(namespaces::getJSONObject)
            .first { it.getString("namespaceId") == "default" }
        require(namespace.getJSONArray("operations").strings().contains(kernelOperation))
        val prefixes = namespace.getJSONArray("keyPrefixes").strings()
        val name = args.getString(if (operation == "v1.kv.list") "prefix" else "key")
        require(prefixes.any(name::startsWith))
        require(selection.getJSONArray("keyPrefixes").strings().all { chosen -> prefixes.any(chosen::startsWith) })
        val requested = selection.getJSONObject("limits")
        val limits = policy.getJSONObject("limits")
        requested.keys().forEach { key -> require(requested.getLong(key) in 1..limits.getLong(key)) }
    }

    companion object {
        private const val MAX_COMMAND_BYTES = 2 * 1024 * 1024
        private const val MAX_VALUE_BYTES = 1024 * 1024
        private val SCALAR = Regex("[A-Za-z0-9:._-]{1,128}")
        fun decodeBinary(array: JSONArray?): List<RuntimeNativeBinary> {
            if (array == null) return emptyList()
            require(array.length() <= 1)
            return (0 until array.length()).map { index ->
                val item = array.getJSONObject(index)
                require(item.getString("handle") == "value")
                val encoded = item.getString("base64")
                require(encoded.length <= 4 * ((MAX_VALUE_BYTES + 2) / 3))
                val bytes = Base64.getDecoder().decode(encoded)
                require(bytes.size <= MAX_VALUE_BYTES && Base64.getEncoder().encodeToString(bytes) == encoded)
                RuntimeNativeBinary("value", bytes)
            }
        }
        fun encodeBinary(binary: List<RuntimeNativeBinary>): JSONArray {
            require(binary.size <= 1)
            return JSONArray().apply { binary.forEach { item ->
                require(item.handle == "value" && item.data.size <= MAX_VALUE_BYTES)
                put(JSONObject().put("handle", item.handle).put("base64", Base64.getEncoder().encodeToString(item.data)))
            } }
        }
        fun failure(code: String) = JSONObject().put("value", JSONObject().put("ok", false)
            .put("error", JSONObject().put("code", code))).toString()
        private fun JSONArray.strings() = (0 until length()).map(::getString)
    }
}
