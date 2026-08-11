package org.json

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** JVM-only Android org.json substitute used by this module's local unit tests. */
class JSONObject private constructor(
    private val values: LinkedHashMap<String, Any?>,
) {
    constructor() : this(linkedMapOf())

    constructor(source: String) : this(readObject(JsonParser.parseString(source)))

    constructor(source: Map<*, *>) : this(linkedMapOf<String, Any?>().apply {
        for ((key, value) in source) if (key is String) put(key, value)
    })

    fun get(key: String): Any = values[key] ?: throw IllegalArgumentException("Missing $key")

    fun has(key: String): Boolean = values.containsKey(key)

    fun length(): Int = values.size

    fun put(key: String, value: Any?): JSONObject = apply { values[key] = value }

    fun put(key: String, value: Boolean): JSONObject = put(key, value as Any)

    fun put(key: String, value: Int): JSONObject = put(key, value as Any)

    fun put(key: String, value: Long): JSONObject = put(key, value as Any)

    fun put(key: String, value: Double): JSONObject = put(key, value as Any)

    override fun toString(): String = GSON.toJson(unwrapJson(this))

    internal fun entries(): Map<String, Any?> = values

    companion object {
        private val GSON = Gson()

        private fun readObject(element: JsonElement): LinkedHashMap<String, Any?> {
            require(element is JsonObject)
            return linkedMapOf<String, Any?>().apply {
                for ((key, value) in element.entrySet()) put(key, read(value))
            }
        }

        private fun read(element: JsonElement): Any? = when {
            element is JsonNull -> null
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

    fun get(index: Int): Any = items[index] ?: throw IllegalArgumentException("Null item")

    fun length(): Int = items.size

    fun put(value: Any?): JSONArray = apply { items += value }

    fun put(value: Boolean): JSONArray = put(value as Any)

    fun put(value: Int): JSONArray = put(value as Any)

    fun put(value: Long): JSONArray = put(value as Any)

    internal fun values(): List<Any?> = items

    override fun toString(): String = Gson().toJson(unwrapJson(this))
}

private fun unwrapJson(value: Any?): Any? = when (value) {
    is JSONObject -> value.entries().mapValues { unwrapJson(it.value) }
    is JSONArray -> value.values().map(::unwrapJson)
    else -> value
}
