package ai.oneworks.holonomy.session

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxOriginVectorsTest {
    private val vectors: JsonObject by lazy {
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream(RESOURCE))
        stream.bufferedReader(Charsets.UTF_8).use { reader ->
            JsonParser.parseReader(reader).asJsonObject
        }
    }

    @Test
    fun `Android canonical origins match shared WHATWG vectors`() {
        val origins = vectors.getAsJsonArray("origins")
        assertTrue(origins.size() >= 24)
        origins.forEach { element ->
            val vector = element.asJsonObject
            val input = vector.get("input").asString
            val expectedCanonical = vector.get("canonical").takeUnless { it.isJsonNull }?.asString
            val actualCanonical = runCatching { canonicalSandboxOrigin(input) }.getOrNull()
            assertEquals("canonical origin for $input", expectedCanonical, actualCanonical)

            val accepted = runCatching {
                SessionSandboxNetworkPolicy(
                    access = SessionSandboxNetworkAccess.RESTRICTED,
                    allowedOrigins = setOf(input),
                    allowedSchemes = setOf("http", "https"),
                )
            }.isSuccess
            assertEquals("origin admission for $input", vector.get("accepted").asBoolean, accepted)
        }
    }

    @Test
    fun `sandbox policy digests match shared canonical vectors`() {
        vectors.getAsJsonArray("digests").forEach { element ->
            val vector = element.asJsonObject
            val access = SessionSandboxNetworkAccess.entries.single {
                it.wireName == vector.get("access").asString
            }
            val network = if (access == SessionSandboxNetworkAccess.NONE) {
                SessionSandboxNetworkPolicy()
            } else {
                SessionSandboxNetworkPolicy(
                    access = access,
                    allowedOrigins = vector.stringSet("allowedOrigins"),
                    allowedSchemes = vector.stringSet("allowedSchemes"),
                    allowPrivateNetwork = vector.get("allowPrivateNetwork").asBoolean,
                )
            }
            val filesystemAccess = SessionSandboxFilesystemAccess.entries.single {
                it.wireName == vector.get("filesystemAccess").asString
            }
            val policy = SessionSandboxPolicy(
                network = network,
                filesystem = SessionSandboxFilesystemPolicy(filesystemAccess),
            )
            assertEquals(
                "sandbox digest ${vector.get("name").asString}",
                vector.get("digest").asString,
                policy.digest,
            )
        }
    }

    private fun JsonObject.stringSet(name: String): Set<String> =
        getAsJsonArray(name).mapTo(linkedSetOf()) { it.asString }

    private companion object {
        private const val RESOURCE = "sandbox-origin-vectors.json"
    }
}
