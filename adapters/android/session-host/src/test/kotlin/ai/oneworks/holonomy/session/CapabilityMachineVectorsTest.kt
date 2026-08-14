package ai.oneworks.holonomy.session

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.math.BigDecimal
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CapabilityMachineVectorsTest {
    @Test
    fun `Android consumes shared SandboxPolicy v2 canonical JSON and digests`() {
        resource("sandbox-policy-v2.vectors.json").getAsJsonArray("vectors").forEach { element ->
            val vector = element.asJsonObject
            val canonical = vector.get("canonicalJson").asString
            assertEquals(canonical, canonicalJson(vector.get("normalized")))
            assertEquals(vector.get("digest").asString, sha256(canonical))
        }
    }

    @Test
    fun `Android recomputes shared filesystem and process semantic digests`() {
        val vectors = resource("canonical-resource-v1.vectors.json").getAsJsonObject("vectors")
        val filesystem = vectors.getAsJsonObject("filesystem")
        assertEquals(
            filesystem.get("semanticResourceDigest").asString,
            digest(
                JsonArray().apply {
                    add("filesystem")
                    add(filesystem.get("rootId"))
                    add(filesystem.get("pathSegments"))
                },
            ),
        )
        val program = vectors.getAsJsonObject("program")
        val shell = vectors.getAsJsonObject("shell")
        assertEquals(program.get("semanticResourceDigest").asString, processDigest(program))
        assertEquals(shell.get("semanticResourceDigest").asString, processDigest(shell))
        assertNotEquals(
            program.get("semanticResourceDigest").asString,
            shell.get("semanticResourceDigest").asString,
        )
        val systemField = vectors.getAsJsonObject("systemField")
        assertEquals(
            systemField.get("semanticResourceDigest").asString,
            digest(JsonArray().apply {
                add("systemField")
                add(systemField.get("field"))
            }),
        )
    }

    @Test
    fun `Android reads shared Device availability and error mapping`() {
        val devices = resource("device-contract-v1.vectors.json").getAsJsonObject("vectors")
        val device = devices.getAsJsonObject("androidProvider")
        assertEquals("android", device.get("target").asString)
        val operations = device.getAsJsonArray("operations")
        assertEquals(15, operations.size())
        assertTrue(operations.all { it.asJsonObject.get("operation").asString.startsWith("device.") })
        assertTrue(operations.any {
            val row = it.asJsonObject
            row.get("operation").asString == "device.events.subscribe" &&
                row.get("supportLevel").asString == "required"
        })

        val errors = resource("capability-error-map-v1.json")
        assertEquals(capabilityErrorExpectations.keys, errors.keySet())
        capabilityErrorExpectations.forEach { (code, expected) ->
            val actual = errors.getAsJsonObject(code)
            val child = actual.getAsJsonObject("childProcess")
            assertEquals(expected.nodeFs, actual.get("nodeFs").asString)
            assertEquals(expected.nodeSystem, actual.get("nodeSystem").asString)
            assertEquals(expected.holo, actual.get("holo").asString)
            assertEquals(expected.childDefault, child.get("default").asString)
            assertEquals(expected.capturedOutput, child.get("capturedOutput")?.asString)
            assertEquals(expected.stdinWrite, child.get("stdinWrite")?.asString)
        }
        assertFalse(errors.has("unknown"))
        assertEquals("desktop", devices.getAsJsonObject("desktopProvider").get("target").asString)
        val node = devices.getAsJsonObject("nodeProvider")
        assertEquals("node", node.get("target").asString)
        assertTrue(node.getAsJsonArray("operations").all {
            val row = it.asJsonObject
            row.get("supportLevel").asString == "required" ||
                row.get("supportLevel").asString == "unsupported"
        })
    }

    @Test
    fun `Android consumes shared Snapshot Engine Gate and Observer discriminants`() {
        val snapshots = resource("invocation-snapshot-v1.vectors.json").getAsJsonArray("vectors")
        assertEquals(listOf("argument", "result"), snapshots.map {
            it.asJsonObject.getAsJsonObject("snapshot").get("direction").asString
        })
        val argumentEntries = snapshots[0].asJsonObject.getAsJsonObject("snapshot")
            .getAsJsonObject("root").getAsJsonArray("entries")
        assertEquals(listOf("body", "callback"), argumentEntries.map {
            it.asJsonObject.get("key").asString
        })

        val gate = resource("engine-gate-v1.vectors.json")
        assertEquals(
            "runtime.code.generate.strings",
            gate.getAsJsonArray("requests")[0].asJsonObject.get("operation").asString,
        )
        assertEquals(listOf("allow", "deny"), gate.getAsJsonArray("decisions").map {
            it.asJsonObject.get("action").asString
        })

        val observer = resource("observer-contract-v1.vectors.json").getAsJsonArray("events")
        assertEquals(listOf("script.compiled", "runtime.terminated"), observer.map {
            it.asJsonObject.get("event").asString
        })
        assertEquals(listOf(1L, 2L), observer.map { it.asJsonObject.get("sequence").asLong })
    }

    @Test
    fun `Android independently checks Runtime restart and Resolution semantic vectors`() {
        val creation = resource("runtime-creation-v1.vectors.json").getAsJsonArray("valid")
        assertEquals(listOf(1L, 2L), creation.map { it.asJsonObject.get("generation").asLong })
        assertEquals(
            creation[0].asJsonObject.get("configurationDigest").asString,
            creation[1].asJsonObject.get("configurationDigest").asString,
        )
        assertNotEquals(
            creation[0].asJsonObject.get("principal").asString,
            creation[1].asJsonObject.get("principal").asString,
        )

        val resolution = resource("resource-resolution-v1.vectors.json")
        val valid = resolution.getAsJsonArray("valid")
        assertEquals(listOf("networkAddress", "filesystemTarget", "opaqueRebind"), valid.map {
            it.asJsonObject.get("reason").asString
        })
        val invalid = resolution.getAsJsonArray("invalid")
        assertEquals(
            listOf(
                "filesystem-cross-root",
                "network-semantic-tamper",
                "opaque-generation-tamper",
                "network-forged-digest",
                "filesystem-forged-root",
            ),
            invalid.map { it.asJsonObject.get("name").asString },
        )
        assertTrue(invalid.all {
            it.asJsonObject.get("expectedCode").asString == "runtime.configuration_invalid" &&
                !isValidResolutionChallenge(it.asJsonObject.getAsJsonObject("value"))
        })
    }

    @Test
    fun `Android independently validates shared virtual path vectors`() {
        val paths = resource("virtual-path-v1.vectors.json")
        paths.getAsJsonArray("valid").forEach { element ->
            val vector = element.asJsonObject
            assertEquals(vector.get("normalized").asString, canonicalVirtualPath(vector.get("input").asString))
        }
        paths.getAsJsonArray("invalid").forEach { element ->
            assertTrue(runCatching { canonicalVirtualPath(element.asString) }.isFailure)
        }
    }

    @Test
    fun `Android independently recomputes Network view digests`() {
        val network = resource("operation-contract-v1.vectors.json").getAsJsonObject("network")
        val request = network.getAsJsonArray("valid")
            .map { it.asJsonObject }
            .first { it.get("name").asString == "request-metadata" }
            .getAsJsonObject("normalized")
        assertEquals(
            request.get("headerDigest").asString,
            networkViewDigest("header", request.getAsJsonArray("headers"), "name"),
        )
        assertEquals(
            request.get("queryDigest").asString,
            networkViewDigest("query", request.getAsJsonArray("query"), "key"),
        )
        assertEquals(
            listOf(
                "request-rejects-mutated-header-view",
                "request-rejects-mutated-query-view",
                "redirect-rejects-307-method-rewrite",
                "redirect-rejects-body-replay-without-body",
            ),
            network.getAsJsonArray("invalid")
                .map { it.asJsonObject }
                .filter { it.get("semantic")?.asBoolean == true }
                .map { it.get("name").asString },
        )
    }

    private fun processDigest(resource: JsonObject): String {
        val invocation = resource.get("invocation").asString
        return digest(
            JsonArray().apply {
                add("processExecutable")
                add(invocation)
                add(resource.get(if (invocation == "program") "executableId" else "shellExecutableId"))
                add(resource.get(if (invocation == "program") "argvDigest" else "commandDigest"))
                add(resource.get("cwdSemanticResourceDigest") ?: JsonNull.INSTANCE)
                add(resource.get("environmentScope"))
                add(resource.get("environmentNamesDigest"))
                add(resource.get("stdioDigest"))
            },
        )
    }

    private fun networkViewDigest(domain: String, entries: JsonArray, key: String): String {
        val output = ByteArrayOutputStream()
        fun writeInt(value: Int) = output.write(byteArrayOf(
            (value ushr 24).toByte(),
            (value ushr 16).toByte(),
            (value ushr 8).toByte(),
            value.toByte(),
        ))
        fun writeField(value: String) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            writeInt(bytes.size)
            output.write(bytes)
        }
        writeInt(1)
        writeField(domain)
        writeInt(entries.size())
        entries.forEach { element ->
            val entry = element.asJsonObject
            writeInt(entry.get("index").asInt)
            writeField(entry.get(key).asString)
            val visibility = entry.get("visibility").asString
            writeField(visibility)
            writeField(if (visibility == "visible") entry.get("value").asString else "")
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(output.toByteArray())
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xFF) }
    }

    private fun isValidResolutionChallenge(challenge: JsonObject): Boolean {
        val requested = challenge.getAsJsonObject("requested")
        val resolved = challenge.getAsJsonObject("resolved")
        val reason = challenge.get("reason").asString
        if (resourceDigest(requested) != requested.get("semanticResourceDigest").asString) return false
        if (resourceDigest(resolved) != resolved.get("semanticResourceDigest").asString) return false
        return when (reason) {
            "networkAddress" ->
                requested.get("semanticResourceDigest").asString ==
                    resolved.get("semanticResourceDigest").asString
            "filesystemTarget" -> requested.get("rootId").asString == resolved.get("rootId").asString
            "opaqueRebind" -> listOf(
                "semanticResourceDigest",
                "bridgeIdentityDigest",
                "generation",
                "resourceType",
                "rightsDigest",
            ).all { requested.get(it) == resolved.get(it) }
            else -> false
        }
    }

    private fun resourceDigest(resource: JsonObject): String = when (resource.get("kind").asString) {
        "filesystem" -> digest(JsonArray().apply {
            add("filesystem")
            add(resource.get("rootId"))
            add(resource.get("pathSegments"))
        })
        "network" -> digest(JsonArray().apply {
            add("network")
            add(resource.get("method"))
            add(resource.get("origin"))
            add(resource.get("pathname"))
            add(resource.get("queryDigest") ?: JsonNull.INSTANCE)
        })
        "opaqueHandle" -> digest(JsonArray().apply {
            add("opaqueHandle")
            add(resource.get("resourceType"))
            add(resource.get("generation"))
            add(resource.get("rightsDigest"))
            add(resource.get("bridgeIdentityDigest"))
        })
        else -> error("unsupported resolution resource kind")
    }

    private fun resource(name: String): JsonObject {
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream(name))
        return stream.bufferedReader(Charsets.UTF_8).use { JsonParser.parseReader(it).asJsonObject }
    }

    private fun canonicalVirtualPath(value: String): String {
        require(!value.contains('\\') && !value.contains('\u0000'))
        val uri = URI(value)
        require(uri.scheme == "holo-fs" && uri.rawQuery == null && uri.rawFragment == null)
        val root = requireNotNull(uri.rawAuthority)
        require(root.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")))
        val rawPath = requireNotNull(uri.rawPath)
        require(rawPath.startsWith('/'))
        val rawSegments = rawPath.removePrefix("/").let { if (it.isEmpty()) emptyList() else it.split('/') }
        require(rawSegments.none { it.isEmpty() || it == "." || it == ".." })
        val segments = rawSegments.map { segment ->
            val decoded = URLDecoder.decode(segment.replace("+", "%2B"), Charsets.UTF_8)
            require(decoded != "." && decoded != ".." && decoded.none { it == '/' || it == '\\' || it == '\u0000' })
            val encoded = URLEncoder.encode(decoded, Charsets.UTF_8).replace("+", "%20")
            require(encoded == segment)
            segment
        }
        return "holo-fs://$root/${segments.joinToString("/")}"
    }

    private fun digest(element: JsonElement): String = sha256(canonicalJson(element))

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xFF) }

    private fun canonicalJson(element: JsonElement): String = when {
        element.isJsonNull -> "null"
        element.isJsonArray -> element.asJsonArray.joinToString(
            separator = ",",
            prefix = "[",
            postfix = "]",
        ) {
            canonicalJson(it)
        }
        element.isJsonObject -> element.asJsonObject.entrySet().sortedBy { entry -> entry.key }
            .joinToString(separator = ",", prefix = "{", postfix = "}") { (key, value) ->
                "${JsonPrimitive(key)}:${canonicalJson(value)}"
            }
        element.asJsonPrimitive.isBoolean -> element.asBoolean.toString()
        element.asJsonPrimitive.isNumber -> canonicalNumber(element.asString)
        else -> element.toString()
    }

    private fun canonicalNumber(value: String): String = BigDecimal(value).stripTrailingZeros().let { number ->
        if (number.compareTo(BigDecimal.ZERO) == 0) "0" else number.toPlainString()
    }
}
