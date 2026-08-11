package ai.oneworks.holonomy.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionProtocolTest {
    @Test
    fun `typed v2 commands expose stable wire identities`() {
        val command = testCreateCommand("runtime_1", "command-1", SessionIsolation.ISOLATED_PROCESS)

        assertEquals(2, command.protocolVersion)
        assertEquals("create", command.kind.wireName)
        assertEquals("runtime", SessionIsolation.LOGICAL_RUNTIME.wireName)
        assertEquals("isolatedProcess", command.spec.isolation.wireName)
    }

    @Test
    fun `identifiers generations and output cursors reject invalid values`() {
        assertThrows(IllegalArgumentException::class.java) { RuntimeId("runtime/escaped") }
        assertThrows(IllegalArgumentException::class.java) {
            StartRuntimeCommand(RuntimeId("runtime"), CommandId("start"), expectedGeneration = -1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            StatusRuntimeCommand(RuntimeId("runtime"), CommandId("status"), afterOutputSequence = -1)
        }
    }

    @Test
    fun `module graph requires a canonical absolute entry`() {
        assertThrows(IllegalArgumentException::class.java) {
            SessionRuntimeSpec(
                entryUrl = "./entry.mjs",
                modules = listOf(SessionModuleSpec("app+local://workspace/entry.mjs", "export {}")),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            SessionRuntimeSpec(
                entryUrl = "app+local://workspace/dir/../entry.mjs",
                modules = listOf(
                    SessionModuleSpec("app+local://workspace/dir/../entry.mjs", "export {}"),
                ),
            )
        }
    }

    @Test
    fun `sandbox policy defaults deny and copies immutable canonical authority`() {
        val defaultPolicy = SessionSandboxPolicy()
        assertEquals(SessionSandboxNetworkAccess.NONE, defaultPolicy.network.access)
        assertEquals(SessionSandboxFilesystemAccess.NONE, defaultPolicy.filesystem.access)
        assertEquals(64, defaultPolicy.digest.length)

        val origins = linkedSetOf("https://api.example")
        val schemes = linkedSetOf("https")
        val restricted = SessionSandboxPolicy(
            network = SessionSandboxNetworkPolicy(
                access = SessionSandboxNetworkAccess.RESTRICTED,
                allowedOrigins = origins,
                allowedSchemes = schemes,
            ),
        )
        origins += "https://later.example"
        schemes += "http"

        assertEquals(setOf("https://api.example"), restricted.network.allowedOrigins)
        assertEquals(setOf("https"), restricted.network.allowedSchemes)
        assertFalse("https://later.example" in restricted.network.allowedOrigins)
    }

    @Test
    fun `sandbox network authority rejects noncanonical origins and exceeds bounded limits`() {
        listOf("HTTPS://api.example", "https://api.example/", "https://api.example:443").forEach { origin ->
            assertThrows(IllegalArgumentException::class.java) {
                SessionSandboxNetworkPolicy(
                    access = SessionSandboxNetworkAccess.RESTRICTED,
                    allowedOrigins = setOf(origin),
                    allowedSchemes = setOf("https"),
                )
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            SessionSandboxNetworkPolicy(
                access = SessionSandboxNetworkAccess.MOCK_ONLY,
                allowedOrigins = emptySet(),
                allowedSchemes = setOf("https"),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            SessionSandboxNetworkPolicy(
                access = SessionSandboxNetworkAccess.RESTRICTED,
                allowedOrigins = (0..SessionProtocolLimits.MAX_SANDBOX_ALLOWED_ORIGINS)
                    .mapTo(linkedSetOf()) { index -> "https://api-$index.example" },
                allowedSchemes = setOf("https"),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            SessionSandboxNetworkLimits(maxConcurrentConnections = 129)
        }
        assertTrue(
            SessionSandboxNetworkPolicy(
                access = SessionSandboxNetworkAccess.MOCK_ONLY,
                allowedOrigins = setOf("http://127.0.0.1:1"),
                allowedSchemes = setOf("http"),
            ).allowedOrigins.isNotEmpty(),
        )
    }

    @Test
    fun `local abstract endpoint validates socket name and quota`() {
        assertEquals(
            "holonomy.session.v2",
            LocalAbstractSessionControlEndpoint("holonomy.session.v2").socketName,
        )
        assertThrows(IllegalArgumentException::class.java) {
            LocalAbstractSessionControlEndpoint("/filesystem/socket")
        }
        assertThrows(IllegalArgumentException::class.java) {
            LocalAbstractSessionControlEndpoint("holonomy", maxMessageBytes = 12)
        }
    }

    @Test
    fun `output snapshots reject gaps in their retained sequence window`() {
        val runtimeId = RuntimeId("runtime")
        assertThrows(IllegalArgumentException::class.java) {
            SessionOutputSnapshot(
                firstAvailableSequence = 1,
                nextSequence = 4,
                events = listOf(
                    SessionOutputEvent(runtimeId, 1, 1, SessionOutputStream.STDOUT, "one"),
                    SessionOutputEvent(runtimeId, 1, 3, SessionOutputStream.STDOUT, "three"),
                ),
            )
        }
    }
}
