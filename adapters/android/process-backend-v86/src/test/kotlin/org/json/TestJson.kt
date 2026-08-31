package org.json

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** JVM-only Android org.json substitute used by this module's local Provider tests. */
class JSONObject private constructor(
    private val values: LinkedHashMap<String, Any?>,
) {
    constructor() : this(linkedMapOf())

    constructor(source: String) : this(readObject(JsonParser.parseString(source)))

    fun get(key: String): Any = values[key] ?: throw IllegalArgumentException("Missing $key")

    fun getBoolean(key: String): Boolean = get(key) as Boolean

    fun getInt(key: String): Int = (get(key) as Number).toInt()

    fun getJSONArray(key: String): JSONArray = get(key) as JSONArray

    fun getJSONObject(key: String): JSONObject = get(key) as JSONObject

    fun getLong(key: String): Long = (get(key) as Number).toLong()

    fun getString(key: String): String = get(key) as String

    fun has(key: String): Boolean = values.containsKey(key)

    fun keys(): MutableIterator<String> = values.keys.iterator()

    fun opt(key: String): Any? = values[key]

    fun optInt(key: String): Int = optInt(key, 0)

    fun optInt(key: String, fallback: Int): Int = (values[key] as? Number)?.toInt() ?: fallback

    fun optJSONArray(key: String): JSONArray? = values[key] as? JSONArray

    fun optJSONObject(key: String): JSONObject? = values[key] as? JSONObject

    fun optLong(key: String): Long = optLong(key, 0)

    fun optLong(key: String, fallback: Long): Long = (values[key] as? Number)?.toLong() ?: fallback

    fun optString(key: String): String = optString(key, "")

    fun optString(key: String, fallback: String): String = when (val value = values[key]) {
        null, NULL -> fallback
        else -> value.toString()
    }

    fun put(key: String, value: Any?): JSONObject = apply { values[key] = value ?: NULL }

    fun put(key: String, value: Boolean): JSONObject = put(key, value as Any)

    fun put(key: String, value: Int): JSONObject = put(key, value as Any)

    fun put(key: String, value: Long): JSONObject = put(key, value as Any)

    override fun toString(): String = GSON.toJson(unwrapJson(this))

    internal fun entries(): Map<String, Any?> = values

    companion object {
        @JvmField
        val NULL: Any = object {
            override fun equals(other: Any?): Boolean = other == null || other === this

            override fun toString(): String = "null"
        }
        private val GSON = Gson()

        private fun readObject(element: JsonElement): LinkedHashMap<String, Any?> {
            require(element is JsonObject)
            return linkedMapOf<String, Any?>().apply {
                for ((key, value) in element.entrySet()) put(key, read(value))
            }
        }

        private fun read(element: JsonElement): Any = when {
            element is JsonNull -> NULL
            element is JsonObject -> JSONObject(readObject(element))
            element is JsonArray -> JSONArray(element.map(::read))
            element.asJsonPrimitive.isBoolean -> element.asBoolean
            element.asJsonPrimitive.isNumber -> element.asNumber
            else -> element.asString
        }
    }
}

class JSONArray private constructor(
    private val items: MutableList<Any?>,
) {
    constructor() : this(mutableListOf())

    constructor(values: Collection<*>) : this(values.toMutableList())

    fun get(index: Int): Any = items[index] ?: JSONObject.NULL

    fun getInt(index: Int): Int = (get(index) as Number).toInt()

    fun getJSONObject(index: Int): JSONObject = get(index) as JSONObject

    fun getString(index: Int): String = get(index) as String

    fun length(): Int = items.size

    fun put(value: Any?): JSONArray = apply { items += value ?: JSONObject.NULL }

    fun put(value: Boolean): JSONArray = put(value as Any)

    fun put(value: Int): JSONArray = put(value as Any)

    fun put(value: Long): JSONArray = put(value as Any)

    internal fun values(): List<Any?> = items

    override fun toString(): String = Gson().toJson(unwrapJson(this))
}

private fun unwrapJson(value: Any?): Any? = when (value) {
    JSONObject.NULL -> null
    is JSONObject -> value.entries().mapValues { unwrapJson(it.value) }
    is JSONArray -> value.values().map(::unwrapJson)
    else -> value
}
