package ai.oneworks.holonomy.session

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.security.MessageDigest

/** Host-side invariants that must hold before a capability bootstrap can run. */
internal object SessionCapabilityRuntime {
    fun configurationForGeneration(spec: SessionRuntimeSpec, generation: Long): String? {
        val source = spec.capabilityRuntimeJson ?: return null
        val root = JsonParser.parseString(source).asJsonObject
        root.exactKeys(
            "initialMiddleware",
            "ownerId",
            "processId",
            "providerConfiguration",
            "runtimeCreation",
        )
        val runtimeCreation = root.objectValue("runtimeCreation").apply {
            exactKeys("configuration", "hostBindings")
        }
        val configuration = runtimeCreation.objectValue("configuration")
        val launch = configuration.objectValue("launch")
        launch.exactKeys(
            "entryUrl",
            "moduleCount",
            "moduleGraphDigest",
            "moduleRootUrl",
            "totalSourceBytes",
        )
        require(launch.stringValue("entryUrl") == spec.entryUrl) { "Capability entry URL mismatch" }
        require(launch.get("moduleCount").asJsonPrimitive.asNumber.toLong() == spec.modules.size.toLong()) {
            "Capability module count mismatch"
        }
        require(launch.get("totalSourceBytes").asJsonPrimitive.asNumber.toLong() == totalSourceBytes(spec)) {
            "Capability module bytes mismatch"
        }
        require(launch.stringValue("moduleGraphDigest") == moduleGraphDigest(spec)) {
            "Capability module graph mismatch"
        }
        val inspector = configuration.objectValue("inspector").apply { exactKeys("enabled") }
        require(inspector.get("enabled").asJsonPrimitive.asBoolean == (spec.inspector != null)) {
            "Capability Inspector configuration mismatch"
        }
        requireNetworkIntersection(configuration, spec.sandboxPolicy.network)
        return JsonObject().apply {
            add("session", root.deepCopy())
            addProperty("generation", generation)
        }.toString()
    }

    private fun requireNetworkIntersection(
        configuration: JsonObject,
        legacy: SessionSandboxNetworkPolicy,
    ) {
        val network = configuration.objectValue("sandboxPolicy").objectValue("network")
        require(network.stringValue("access") == legacy.access.wireName) { "Capability network mode mismatch" }
        if (legacy.access == SessionSandboxNetworkAccess.NONE) {
            network.exactKeys("access")
            return
        }
        network.exactKeys(
            "access",
            "allowedOrigins",
            "allowedSchemes",
            "allowPrivateNetwork",
            "limits",
            "requestBodyInspection",
        )
        require(network.stringArray("allowedOrigins") == legacy.allowedOrigins.toList()) {
            "Capability network origins mismatch"
        }
        require(network.stringArray("allowedSchemes") == legacy.allowedSchemes.toList()) {
            "Capability network schemes mismatch"
        }
        require(network.get("allowPrivateNetwork").asBoolean == legacy.allowPrivateNetwork) {
            "Capability private-network authority mismatch"
        }
        val limits = network.objectValue("limits").apply {
            exactKeys(
                "maxChunkBytes",
                "maxConcurrentConnections",
                "maxHeaderBytes",
                "maxHeaders",
                "maxRedirects",
                "maxRequestBodyBytes",
                "maxResponseBodyBytes",
                "maxUrlBytes",
                "socketTimeoutMs",
            )
        }
        val expected = legacy.limits
        require(
            limits.intValue("maxChunkBytes") == expected.maxChunkBytes &&
                limits.intValue("maxConcurrentConnections") == expected.maxConcurrentConnections &&
                limits.intValue("maxHeaderBytes") == expected.maxHeaderBytes &&
                limits.intValue("maxHeaders") == expected.maxHeaders &&
                limits.intValue("maxRequestBodyBytes") == expected.maxRequestBodyBytes &&
                limits.intValue("maxResponseBodyBytes") == expected.maxResponseBodyBytes &&
                limits.intValue("maxUrlBytes") == expected.maxUrlBytes &&
                limits.intValue("socketTimeoutMs") == expected.socketTimeoutMs &&
                limits.intValue("maxRedirects") == 10
        ) { "Capability network limits mismatch" }
        val inspection = network.objectValue("requestBodyInspection").apply { exactKeys("access") }
        require(inspection.stringValue("access") == "none") {
            "Capability request-body inspection is unavailable"
        }
    }

    private fun totalSourceBytes(spec: SessionRuntimeSpec): Long =
        spec.modules.sumOf { module -> module.source.toByteArray(Charsets.UTF_8).size.toLong() }

    private fun moduleGraphDigest(spec: SessionRuntimeSpec): String = canonicalDigest(
        JsonArray().apply {
            add("nodeModuleGraphV1")
            add(JsonArray().apply {
                spec.modules.sortedBy(SessionModuleSpec::url).forEach { module ->
                    add(JsonArray().apply {
                        add(module.url)
                        add(sha256(module.source.toByteArray(Charsets.UTF_8)))
                    })
                }
            })
        },
    )

    private fun canonicalDigest(value: JsonElement): String =
        sha256(canonicalJson(value).toByteArray(Charsets.UTF_8))

    private fun canonicalJson(value: JsonElement): String = when {
        value.isJsonNull || value.isJsonPrimitive -> value.toString()
        value.isJsonArray -> value.asJsonArray.joinToString(
            separator = ",",
            prefix = "[",
            postfix = "]",
        ) { canonicalJson(it) }
        else -> value.asJsonObject.entrySet().sortedBy { it.key }
            .joinToString(separator = ",", prefix = "{", postfix = "}") { (key, child) ->
                "${JsonPrimitive(key)}:" +
                    canonicalJson(child)
            }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun JsonObject.exactKeys(vararg keys: String) {
        require(keySet() == keys.toSet()) { "Invalid Capability Runtime object keys" }
    }

    private fun JsonObject.objectValue(key: String): JsonObject =
        get(key)?.takeIf(JsonElement::isJsonObject)?.asJsonObject
            ?: throw IllegalArgumentException("Missing Capability Runtime object")

    private fun JsonObject.stringValue(key: String): String =
        get(key)?.takeIf(JsonElement::isJsonPrimitive)?.asString
            ?: throw IllegalArgumentException("Missing Capability Runtime string")

    private fun JsonObject.intValue(key: String): Int =
        get(key)?.takeIf(JsonElement::isJsonPrimitive)?.asInt
            ?: throw IllegalArgumentException("Missing Capability Runtime integer")

    private fun JsonObject.stringArray(key: String): List<String> =
        get(key)?.takeIf(JsonElement::isJsonArray)?.asJsonArray?.map { value ->
            value.takeIf(JsonElement::isJsonPrimitive)?.asString
                ?: throw IllegalArgumentException("Invalid Capability Runtime string array")
        } ?: throw IllegalArgumentException("Missing Capability Runtime string array")
}
