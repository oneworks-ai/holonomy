package ai.oneworks.holonomy.session

import com.google.gson.JsonParser
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SessionCapabilityRuntimeTest {
    @Test
    fun acceptsServiceCanonicalModuleGraphDigest() {
        val source = "export const value = 1"
        val entryUrl = "app+local://workspace/entry.mjs"
        val spec = SessionRuntimeSpec(
            entryUrl = entryUrl,
            modules = listOf(SessionModuleSpec(entryUrl, source)),
            capabilityRuntimeJson = capabilityRuntimeJson(entryUrl, source),
        )

        val envelope = JsonParser.parseString(
            requireNotNull(SessionCapabilityRuntime.configurationForGeneration(spec, 2)),
        ).asJsonObject

        assertEquals(2L, envelope.get("generation").asLong)
    }

    @Test
    fun rejectsModuleGraphDigestThatDoesNotMatchTheServiceLaunch() {
        val source = "export const value = 1"
        val entryUrl = "app+local://workspace/entry.mjs"
        val capabilityRuntime = JsonParser.parseString(
            capabilityRuntimeJson(entryUrl, source),
        ).asJsonObject
        capabilityRuntime.getAsJsonObject("runtimeCreation")
            .getAsJsonObject("configuration")
            .getAsJsonObject("launch")
            .addProperty("moduleGraphDigest", "0".repeat(64))
        val spec = SessionRuntimeSpec(
            entryUrl = entryUrl,
            modules = listOf(SessionModuleSpec(entryUrl, source)),
            capabilityRuntimeJson = capabilityRuntime.toString(),
        )

        assertThrows(IllegalArgumentException::class.java) {
            SessionCapabilityRuntime.configurationForGeneration(spec, 1)
        }
    }

    @Test
    fun rejectsCapabilityNetworkAuthorityThatDiffersFromTheAndroidTransport() {
        val source = "export const value = 1"
        val entryUrl = "app+local://workspace/entry.mjs"
        val policy = SessionSandboxPolicy(
            network = SessionSandboxNetworkPolicy(
                access = SessionSandboxNetworkAccess.RESTRICTED,
                allowedOrigins = setOf("https://api.example"),
                allowedSchemes = setOf("https"),
            ),
        )
        val capabilityRuntime = JsonParser.parseString(
            capabilityRuntimeJson(entryUrl, source, policy),
        ).asJsonObject
        capabilityRuntime.getAsJsonObject("runtimeCreation")
            .getAsJsonObject("configuration")
            .getAsJsonObject("sandboxPolicy")
            .getAsJsonObject("network")
            .addProperty("allowPrivateNetwork", true)
        val spec = SessionRuntimeSpec(
            entryUrl = entryUrl,
            modules = listOf(SessionModuleSpec(entryUrl, source)),
            sandboxPolicy = policy,
            capabilityRuntimeJson = capabilityRuntime.toString(),
        )

        assertThrows(IllegalArgumentException::class.java) {
            SessionCapabilityRuntime.configurationForGeneration(spec, 1)
        }
    }

    private fun capabilityRuntimeJson(
        entryUrl: String,
        source: String,
        policy: SessionSandboxPolicy = SessionSandboxPolicy(),
    ): String {
        val graphDigest = sha256(
            "[\"nodeModuleGraphV1\",[[\"$entryUrl\",\"${sha256(source)}\"]]]",
        )
        val network = capabilityNetworkJson(policy.network)
        return """
            {
              "initialMiddleware":{},
              "ownerId":"service",
              "processId":"process_test",
              "providerConfiguration":{},
              "runtimeCreation":{
                "configuration":{
                  "inspector":{"enabled":false},
                  "sandboxPolicy":{"network":$network},
                  "launch":{
                    "entryUrl":"$entryUrl",
                    "moduleCount":1,
                    "moduleGraphDigest":"$graphDigest",
                    "moduleRootUrl":"app+local://workspace/",
                    "totalSourceBytes":${source.toByteArray().size}
                  }
                },
                "hostBindings":{}
              }
            }
        """.trimIndent()
    }

    private fun capabilityNetworkJson(policy: SessionSandboxNetworkPolicy): String {
        if (policy.access == SessionSandboxNetworkAccess.NONE) return "{\"access\":\"none\"}"
        val limits = policy.limits
        val origins = policy.allowedOrigins.joinToString(",") { "\"$it\"" }
        val schemes = policy.allowedSchemes.joinToString(",") { "\"$it\"" }
        return """
            {
              "access":"${policy.access.wireName}",
              "allowedOrigins":[$origins],
              "allowedSchemes":[$schemes],
              "allowPrivateNetwork":${policy.allowPrivateNetwork},
              "limits":{
                "maxChunkBytes":${limits.maxChunkBytes},
                "maxConcurrentConnections":${limits.maxConcurrentConnections},
                "maxHeaderBytes":${limits.maxHeaderBytes},
                "maxHeaders":${limits.maxHeaders},
                "maxRedirects":10,
                "maxRequestBodyBytes":${limits.maxRequestBodyBytes},
                "maxResponseBodyBytes":${limits.maxResponseBodyBytes},
                "maxUrlBytes":${limits.maxUrlBytes},
                "socketTimeoutMs":${limits.socketTimeoutMs}
              },
              "requestBodyInspection":{"access":"none"}
            }
        """.trimIndent()
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }
}
