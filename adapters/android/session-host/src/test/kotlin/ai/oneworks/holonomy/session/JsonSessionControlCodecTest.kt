package ai.oneworks.holonomy.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class JsonSessionControlCodecTest {
    private val codec = JsonSessionControlCodec()

    @Test
    fun `all typed v2 commands round trip`() {
        val runtimeId = RuntimeId("runtime")
        val commands = listOf(
            CreateRuntimeCommand(
                runtimeId = runtimeId,
                commandId = CommandId("create"),
                spec = SessionRuntimeSpec(
                    entryUrl = "app+local://workspace/entry.mjs",
                    modules = listOf(
                        SessionModuleSpec("app+local://workspace/entry.mjs", "export const value = 1"),
                        SessionModuleSpec("app+local://workspace/dep.mjs", "export const dep = 2"),
                    ),
                    argv = listOf("--mode", "test"),
                    env = mapOf("MODE" to "test"),
                    inspector = SessionInspectorSpec("holonomy.inspector", breakBeforeEntry = true),
                    isolation = SessionIsolation.LOGICAL_RUNTIME,
                    initialControls = listOf(
                        SessionControlOperation("network.updateRules", "{\"mode\":\"deny\"}"),
                    ),
                    sandboxPolicy = SessionSandboxPolicy(
                        network = SessionSandboxNetworkPolicy(
                            access = SessionSandboxNetworkAccess.RESTRICTED,
                            allowedOrigins = setOf("https://api.example"),
                            allowedSchemes = setOf("https"),
                            limits = SessionSandboxNetworkLimits(maxConcurrentConnections = 2),
                        ),
                    ),
                ),
            ),
            StartRuntimeCommand(runtimeId, CommandId("start"), 0),
            StatusRuntimeCommand(runtimeId, CommandId("status"), 1, 7),
            CancelRuntimeCommand(runtimeId, CommandId("cancel"), 1, "cancelled"),
            StopRuntimeCommand(runtimeId, CommandId("stop"), 1, "stopped"),
            RestartRuntimeCommand(runtimeId, CommandId("restart"), 1),
            ControlRuntimeCommand(
                runtimeId,
                CommandId("control"),
                2,
                SessionControlOperation("network.updateRules", "{\"mode\":\"allow\"}"),
            ),
            DisposeRuntimeCommand(runtimeId, CommandId("dispose"), 2),
        )

        commands.forEach { command ->
            assertEquals(command, codec.decodeCommand(codec.encodeCommand(command)))
        }
    }

    @Test
    fun `reply state result and output round trip`() {
        val runtimeId = RuntimeId("runtime")
        val state = SessionRuntimeSnapshot(
            runtimeId,
            2,
            SessionRuntimePhase.COMPLETED,
            SessionIsolation.LOGICAL_RUNTIME,
            4,
            7,
        )
        val reply = SessionCommandReply(
            ack = SessionCommandAck(
                runtimeId = runtimeId,
                commandId = CommandId("status"),
                command = SessionCommandKind.STATUS,
                generation = 2,
                accepted = true,
            ),
            state = state,
            result = SessionExecutionResult(runtimeId, 2, 0, "complete"),
            output = SessionOutputSnapshot(
                firstAvailableSequence = 4,
                nextSequence = 7,
                events = listOf(
                    SessionOutputEvent(runtimeId, 2, 4, SessionOutputStream.STDOUT, "hello"),
                    SessionOutputEvent(runtimeId, 2, 5, SessionOutputStream.STDERR, "world"),
                    SessionOutputEvent(runtimeId, 2, 6, SessionOutputStream.NETWORK, "{\"kind\":\"requestStarted\"}"),
                ),
            ),
        )

        assertEquals(reply, codec.decodeReply(codec.encodeReply(reply)))
        assertEquals(state, codec.decodeState(codec.encodeState(state)))
        assertEquals(reply.result, codec.decodeResult(codec.encodeResult(reply.result!!)))
        assertEquals(reply.output, codec.decodeOutput(codec.encodeOutput(reply.output!!)))
    }

    @Test
    fun `malformed utf8 and unsupported protocol fail closed`() {
        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(byteArrayOf(0xc3.toByte(), 0x28))
        }
        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(
                """{"protocolVersion":1,"runtimeId":"runtime","commandId":"status","command":"status"}"""
                    .toByteArray(),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(
                """{"protocolVersion":2,"runtimeId":"runtime","commandId":"create","command":"create","spec":{"entryUrl":"app+local://workspace/entry.mjs","modules":[{"url":"app+local://workspace/entry.mjs","source":"export {}"}],"isolation":"logicalRuntime"}}"""
                    .toByteArray(),
            )
        }
    }

    @Test
    fun `missing sandbox policy defaults deny and caller authority fields are rejected`() {
        val base = """{"protocolVersion":2,"runtimeId":"runtime","commandId":"create","command":"create","spec":{"entryUrl":"app+local://workspace/entry.mjs","modules":[{"url":"app+local://workspace/entry.mjs","source":"export {}"}]}}"""
        val decoded = codec.decodeCommand(base.toByteArray()) as CreateRuntimeCommand
        assertEquals(SessionSandboxPolicy(), decoded.spec.sandboxPolicy)

        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(base.replace("\"entryUrl\"", "\"principal\":\"caller\",\"entryUrl\"").toByteArray())
        }
        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(base.replace("\"command\":\"create\"", "\"command\":\"create\",\"extra\":true").toByteArray())
        }
    }

    @Test
    fun `sandbox policy JSON is strict and bounded`() {
        val prefix = """{"protocolVersion":2,"runtimeId":"runtime","commandId":"create","command":"create","spec":{"entryUrl":"app+local://workspace/entry.mjs","modules":[{"url":"app+local://workspace/entry.mjs","source":"export {}"}],"sandboxPolicy":"""
        val suffix = "}}"
        val valid = """{"schemaVersion":1,"network":{"access":"mockOnly","allowedOrigins":["https://mock.example"],"allowedSchemes":["https"],"allowPrivateNetwork":false,"limits":{"maxChunkBytes":65536,"maxConcurrentConnections":8,"maxHeaderBytes":65536,"maxHeaders":128,"maxRequestBodyBytes":1048576,"maxResponseBodyBytes":8388608,"maxUrlBytes":65536,"socketTimeoutMs":30000}},"filesystem":{"access":"none"}}"""
        val decoded = codec.decodeCommand((prefix + valid + suffix).toByteArray()) as CreateRuntimeCommand
        assertEquals(SessionSandboxNetworkAccess.MOCK_ONLY, decoded.spec.sandboxPolicy.network.access)

        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(
                (prefix + valid.replace("\"access\":\"none\"", "\"access\":\"none\",\"root\":\"/\"") + suffix)
                    .toByteArray(),
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            codec.decodeCommand(
                (prefix + valid.replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"principal\":\"caller\"") + suffix)
                    .toByteArray(),
            )
        }
    }
}
