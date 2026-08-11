package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import org.json.JSONArray
import org.json.JSONObject

internal object NetworkV1 {
    const val CANCEL = "v1.http.cancel"
    const val CLOSE = "v1.http.close"
    const val FINISH_BODY = "v1.http.finish-body"
    const val MODULE = "host.network"
    const val MODULE_CAPABILITY = "host.network.http"
    const val OPEN_BODY = "v1.http.open-body"
    const val READ_BODY = "v1.http.read-body"
    const val REQUEST = "v1.http.request"
    const val RESOURCE_TYPE = "network.http"
    const val WRITE_BODY = "v1.http.write-body"

    val operations = setOf(REQUEST, OPEN_BODY, WRITE_BODY, FINISH_BODY, READ_BODY, CANCEL, CLOSE)
}

internal data class ProviderRequest(
    val id: String,
    val module: String,
    val operation: String,
    val args: JSONObject,
    val deadlineMs: Long?,
)

internal data class ProviderResourceBinding(
    val ownerCallToken: String,
    val providerToken: String,
    val reference: String,
    val type: String,
)

internal data class ProviderContext(
    val callToken: String,
    val capabilities: Set<String>,
    val mode: String,
    val principal: String,
    val resources: List<ProviderResourceBinding>,
)

internal fun parseProviderRequest(requestId: String, source: String): ProviderRequest {
    require(REQUEST_ID.matches(requestId))
    val value = JSONObject(source)
    val hasDeadline = value.has("deadlineMs")
    require(value.hasExactKeys(*(if (hasDeadline) REQUEST_KEYS_WITH_DEADLINE else REQUEST_KEYS)))
    require(readString(value, "id", REQUEST_ID) == requestId)
    val deadline = if (hasDeadline) readSafeLong(value, "deadlineMs") else null
    return ProviderRequest(
        id = requestId,
        module = readString(value, "module", PROTOCOL_SCALAR),
        operation = readString(value, "operation", PROTOCOL_SCALAR),
        args = value.get("args") as? JSONObject ?: throw IllegalArgumentException(),
        deadlineMs = deadline,
    )
}

internal fun parseProviderContext(source: String): ProviderContext {
    val value = JSONObject(source)
    require(value.hasExactKeys("authority", "callToken", "mode", "resources"))
    val authority = value.get("authority") as? JSONObject ?: throw IllegalArgumentException()
    require(authority.hasExactKeys("capabilities", "principal"))
    val capabilitiesJson = authority.get("capabilities") as? JSONArray ?: throw IllegalArgumentException()
    require(capabilitiesJson.length() <= MAX_CAPABILITIES)
    val capabilities = LinkedHashSet<String>()
    repeat(capabilitiesJson.length()) { index ->
        val capability = capabilitiesJson.get(index) as? String ?: throw IllegalArgumentException()
        require(CAPABILITY.matches(capability) && capabilities.add(capability))
    }
    val resourcesJson = value.get("resources") as? JSONArray ?: throw IllegalArgumentException()
    require(resourcesJson.length() <= MAX_RESOURCES)
    val resources = List(resourcesJson.length()) { index ->
        val binding = resourcesJson.get(index) as? JSONObject ?: throw IllegalArgumentException()
        require(binding.hasExactKeys("ownerCallToken", "providerToken", "reference", "type"))
        val reference = binding.get("reference") as? JSONObject ?: throw IllegalArgumentException()
        require(reference.hasExactKeys("resource"))
        ProviderResourceBinding(
            ownerCallToken = readString(binding, "ownerCallToken", CALL_TOKEN),
            providerToken = readString(binding, "providerToken", PROVIDER_TOKEN),
            reference = readString(reference, "resource", RESOURCE_REFERENCE),
            type = readString(binding, "type", RESOURCE_TYPE),
        )
    }
    val mode = readString(value, "mode", MODE)
    return ProviderContext(
        callToken = readString(value, "callToken", CALL_TOKEN),
        capabilities = capabilities,
        mode = mode,
        principal = readString(authority, "principal", PRINCIPAL),
        resources = resources,
    )
}

internal fun success(id: String, value: JSONObject, resources: JSONArray? = null): RuntimeNativeEvent {
    val event = JSONObject()
        .put("id", id)
        .put("type", "result")
        .put("value", successEnvelope(value))
    if (resources != null) event.put("resources", resources)
    return RuntimeNativeEvent(event.toString())
}

internal fun networkFailureResult(id: String, code: String): RuntimeNativeEvent = RuntimeNativeEvent(
    JSONObject()
        .put("id", id)
        .put("type", "result")
        .put("value", JSONObject().put("error", code).put("ok", false))
        .toString(),
)

internal fun failure(
    id: String,
    code: String,
    domain: String? = null,
    resource: String? = null,
): RuntimeNativeEvent {
    val error = JSONObject().put("code", code)
    if (domain != null) error.put("domain", domain)
    if (resource != null) error.put("details", JSONObject().put("resource", resource))
    return RuntimeNativeEvent(
        JSONObject().put("id", id).put("type", "error").put("error", error).toString(),
    )
}

internal fun streamChunk(id: String, sequence: Int, data: ByteArray): RuntimeNativeEvent = RuntimeNativeEvent(
    JSONObject()
        .put("id", id)
        .put("sequence", sequence)
        .put("type", "chunk")
        .put("value", successEnvelope(JSONObject().put("kind", "body")))
        .toString(),
    listOf(RuntimeNativeBinary("android-network-body:$sequence", data)),
)

internal fun streamEnd(id: String): RuntimeNativeEvent = RuntimeNativeEvent(
    JSONObject()
        .put("id", id)
        .put("type", "end")
        .put("value", successEnvelope(JSONObject().put("closed", true)))
        .toString(),
)

internal fun streamFailure(id: String, code: String): RuntimeNativeEvent = RuntimeNativeEvent(
    JSONObject()
        .put("id", id)
        .put("type", "end")
        .put("value", JSONObject().put("error", code).put("ok", false))
        .toString(),
)

internal fun resourceReference(args: JSONObject): String? = runCatching {
    if (!args.hasExactKeys("response")) return null
    val reference = args.get("response") as? JSONObject ?: return null
    if (!reference.hasExactKeys("resource")) return null
    readString(reference, "resource", RESOURCE_REFERENCE)
}.getOrNull()

internal fun JSONObject.hasExactKeys(vararg expected: String): Boolean {
    if (length() != expected.size) return false
    for (key in expected) if (!has(key)) return false
    return true
}

private fun successEnvelope(value: JSONObject): JSONObject = JSONObject().put("ok", true).put("value", value)

private fun readString(value: JSONObject, key: String, pattern: Regex): String {
    val output = value.get(key) as? String ?: throw IllegalArgumentException()
    require(pattern.matches(output))
    return output
}

private fun readSafeLong(value: JSONObject, key: String): Long {
    val number = value.get(key) as? Number ?: throw IllegalArgumentException()
    if (number is Byte || number is Short || number is Int || number is Long) {
        val integer = number.toLong()
        require(integer in 0..MAX_SAFE_INTEGER)
        return integer
    }
    val double = number.toDouble()
    require(double.isFinite() && double >= 0.0 && double < MAX_UNSAFE_INTEGER && double % 1.0 == 0.0)
    return double.toLong()
}

private const val MAX_CAPABILITIES = 128
private const val MAX_RESOURCES = 16
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val MAX_UNSAFE_INTEGER = 9_007_199_254_740_992.0
private val REQUEST_KEYS = arrayOf("args", "id", "module", "operation")
private val REQUEST_KEYS_WITH_DEADLINE = arrayOf("args", "deadlineMs", "id", "module", "operation")
private val CALL_TOKEN = Regex("^[A-Za-z0-9:._-]{1,128}$")
private val CAPABILITY = Regex("^[A-Za-z0-9:._/-]{1,128}$")
private val MODE = Regex("^(?:result|stream)$")
private val PRINCIPAL = Regex("^[A-Za-z0-9:._-]{1,128}$")
private val PROTOCOL_SCALAR = Regex("^[A-Za-z0-9:._-]{1,128}$")
private val PROVIDER_TOKEN = Regex("^[A-Za-z0-9:._-]{1,128}$")
private val REQUEST_ID = Regex("^[A-Za-z0-9:._-]{1,128}$")
private val RESOURCE_REFERENCE = Regex("^resource:[0-9]{1,10}$")
private val RESOURCE_TYPE = Regex("^[A-Za-z0-9:._-]{1,128}$")
