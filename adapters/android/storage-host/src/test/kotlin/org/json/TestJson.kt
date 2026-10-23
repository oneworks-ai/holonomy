package org.json

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** Module-local JVM implementation of Android JSON; Gson version is shared with network-host. */
class JSONObject private constructor(private val values: LinkedHashMap<String, Any?>) {
    constructor() : this(linkedMapOf())
    constructor(source: String) : this(readObject(JsonParser.parseString(source)))
    fun get(key: String): Any = values[key] ?: NULL
    fun has(key: String) = values.containsKey(key)
    fun length() = values.size
    fun put(key: String, value: Any?): JSONObject = apply { values[key] = value }
    fun put(key: String, value: Boolean): JSONObject = put(key, value as Any)
    fun put(key: String, value: Int): JSONObject = put(key, value as Any)
    fun put(key: String, value: Long): JSONObject = put(key, value as Any)
    fun put(key: String, value: Double): JSONObject = put(key, value as Any)
    override fun toString(): String = GsonBuilder().serializeNulls().create().toJson(unwrap(this))
    internal fun entries() = values

    companion object {
        @JvmField val NULL: Any = object {}
        private fun readObject(value: JsonElement): LinkedHashMap<String, Any?> {
            require(value is JsonObject)
            return linkedMapOf<String, Any?>().apply {
                for ((key, item) in value.entrySet()) put(key, read(item))
            }
        }
        internal fun read(value: JsonElement): Any? = when {
            value is JsonNull -> NULL
            value is JsonObject -> JSONObject(readObject(value))
            value is JsonArray -> JSONArray(value.map(::read))
            value.asJsonPrimitive.isBoolean -> value.asBoolean
            value.asJsonPrimitive.isNumber -> value.asNumber
            else -> value.asString
        }
    }
}

class JSONArray private constructor(private val items: MutableList<Any?>) {
    constructor() : this(mutableListOf())
    constructor(values: Collection<*>) : this(values.toMutableList())
    fun get(index: Int): Any = items[index] ?: JSONObject.NULL
    fun length() = items.size
    fun put(value: Any?): JSONArray = apply { items.add(value) }
    internal fun values() = items
    override fun toString(): String = Gson().toJson(unwrap(this))
}

private fun unwrap(value: Any?): Any? = when {
    value === JSONObject.NULL -> null
    value is JSONObject -> value.entries().mapValues { unwrap(it.value) }
    value is JSONArray -> value.values().map(::unwrap)
    else -> value
}
