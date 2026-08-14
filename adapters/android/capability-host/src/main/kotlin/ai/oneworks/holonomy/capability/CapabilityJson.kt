package ai.oneworks.holonomy.capability

import org.json.JSONArray
import org.json.JSONObject

internal class ProviderFailure(val code: String) : IllegalStateException(code)

internal fun success(value: Any, resources: List<JSONObject> = emptyList()): String = JSONObject()
    .put("ok", true)
    .put("value", value)
    .apply {
        if (resources.isNotEmpty()) put("resources", JSONArray(resources))
    }
    .toString()

internal fun failure(code: String): String = JSONObject()
    .put("ok", false)
    .put("error", JSONObject().put("code", code))
    .toString()

internal fun resourcePublication(
    bindingId: String,
    resourceType: String,
    eventSchemaId: String? = null,
): JSONObject = JSONObject()
    .put("bindingId", bindingId)
    .put("resourceType", resourceType)
    .apply { if (eventSchemaId != null) put("eventSchemaId", eventSchemaId) }

internal fun JSONObject.requireOnlyKeys(vararg allowed: String) {
    val keys = allowed.toSet()
    require(length() == keys.size && keys().asSequence().all(keys::contains))
}

internal fun JSONArray.strings(): List<String> = List(length()) { index -> getString(index) }

internal fun JSONArray.objects(): List<JSONObject> = List(length()) { index -> getJSONObject(index) }

internal fun jsonValue(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is JSONObject -> JSONObject(value.toString())
    is JSONArray -> JSONArray(value.toString())
    else -> value
}
