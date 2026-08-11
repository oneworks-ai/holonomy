package ai.oneworks.holonomy.session

import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class AppPrivateSessionCommandStoreTest {
    @Test
    fun `command reply state result and output round trip atomically`() {
        val directory = Files.createTempDirectory("holonomy-session-store").toFile()
        try {
            val store = AppPrivateSessionCommandStore(directory, MemoryCodec())
            val command = testCreateCommand("runtime", "command")
            val state = SessionRuntimeSnapshot(
                runtimeId = command.runtimeId,
                generation = 1,
                phase = SessionRuntimePhase.RUNNING,
                isolation = SessionIsolation.LOGICAL_RUNTIME,
                firstAvailableOutputSequence = 1,
                nextOutputSequence = 2,
            )
            val result = SessionExecutionResult(command.runtimeId, 1, 0)
            val output = SessionOutputSnapshot(
                firstAvailableSequence = 1,
                nextSequence = 2,
                events = listOf(
                    SessionOutputEvent(command.runtimeId, 1, 1, SessionOutputStream.STDOUT, "hello"),
                ),
            )
            val reply = SessionCommandReply(
                ack = SessionCommandAck(
                    runtimeId = command.runtimeId,
                    commandId = command.commandId,
                    command = command.kind,
                    generation = 1,
                    accepted = true,
                ),
                state = state,
                result = result,
                output = output,
            )

            assertTrue(store.putCommand(command))
            assertFalse(store.putCommand(command))
            assertEquals(listOf(command), store.pendingCommands())
            store.putReply(reply)
            store.putState(state)
            store.putResult(result)
            store.putOutput(output, command.runtimeId)

            assertEquals(command, store.readCommand(command.commandId))
            assertEquals(reply, store.readReply(command.commandId))
            assertEquals(state, store.readState(command.runtimeId))
            assertEquals(result, store.readResult(command.runtimeId))
            assertEquals(output, store.readOutput(command.runtimeId))
            assertTrue(store.pendingCommands().isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun `command identity collision and oversized artifacts fail closed`() {
        val directory = Files.createTempDirectory("holonomy-session-store").toFile()
        try {
            val codec = MemoryCodec(encodedBytes = 64)
            val store = AppPrivateSessionCommandStore(
                directory,
                codec,
                SessionCommandStoreLimits(maxArtifactBytes = 32),
            )
            assertThrows(IllegalArgumentException::class.java) {
                store.putCommand(testCreateCommand("runtime", "command"))
            }

            val bounded = AppPrivateSessionCommandStore(directory.resolve("bounded"), MemoryCodec())
            bounded.putCommand(testCreateCommand("runtime", "same"))
            assertThrows(IllegalStateException::class.java) {
                bounded.putCommand(testCreateCommand("other", "same"))
            }
            assertNull(bounded.readReply(CommandId("same")))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun `completed command artifacts retain pending work and the recent replay window`() {
        val directory = Files.createTempDirectory("holonomy-session-store-history").toFile()
        try {
            val store = AppPrivateSessionCommandStore(
                directory,
                MemoryCodec(),
                SessionCommandStoreLimits(maxCommandHistory = 2),
            )
            val pending = testCreateCommand("pending", "pending")
            assertTrue(store.putCommand(pending))
            val completed = (1..3).map { index ->
                testCreateCommand("runtime-$index", "completed-$index").also { command ->
                    assertTrue(store.putCommand(command))
                    store.putReply(acceptedReply(command))
                }
            }

            assertEquals(pending, store.readCommand(pending.commandId))
            assertNull(store.readCommand(completed[0].commandId))
            assertNull(store.readReply(completed[0].commandId))
            completed.takeLast(2).forEach { command ->
                assertEquals(command, store.readCommand(command.commandId))
                assertEquals(acceptedReply(command), store.readReply(command.commandId))
            }
            assertFalse(store.putCommand(completed.last()))
            assertEquals(listOf(pending), store.pendingCommands())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun `symbolic link store root is rejected before canonicalization`() {
        val directory = Files.createTempDirectory("holonomy-session-store-link")
        val actual = Files.createDirectory(directory.resolve("actual"))
        val link = directory.resolve("link")
        try {
            Files.createSymbolicLink(link, actual)

            assertThrows(IllegalArgumentException::class.java) {
                AppPrivateSessionCommandStore(link.toFile(), MemoryCodec())
            }
        } finally {
            Files.deleteIfExists(link)
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `supervisor event sink persists bounded asynchronous snapshots`() {
        val directory = Files.createTempDirectory("holonomy-session-event-store").toFile()
        try {
            val store = AppPrivateSessionCommandStore(directory, MemoryCodec())
            val sink = StoredSessionSupervisorEventSink(
                store,
                StoredSessionOutputLimits(maxEvents = 2, maxBytes = 64),
            )
            val runtimeId = RuntimeId("runtime")
            sink.onState(
                SessionRuntimeSnapshot(
                    runtimeId = runtimeId,
                    generation = 1,
                    phase = SessionRuntimePhase.RUNNING,
                    isolation = SessionIsolation.LOGICAL_RUNTIME,
                    firstAvailableOutputSequence = 1,
                    nextOutputSequence = 1,
                ),
            )
            sink.onOutput(SessionOutputEvent(runtimeId, 1, 1, SessionOutputStream.STDOUT, "one"))
            sink.onOutput(SessionOutputEvent(runtimeId, 1, 2, SessionOutputStream.STDERR, "two"))
            sink.onOutput(SessionOutputEvent(runtimeId, 1, 3, SessionOutputStream.STDOUT, "three"))
            sink.onResult(SessionExecutionResult(runtimeId, 1, 0))

            assertEquals(SessionRuntimePhase.RUNNING, store.readState(runtimeId)?.phase)
            assertEquals(0, store.readResult(runtimeId)?.exitCode)
            val output = store.readOutput(runtimeId)!!
            assertEquals(2, output.firstAvailableSequence)
            assertEquals(4, output.nextSequence)
            assertEquals(listOf("two", "three"), output.events.map(SessionOutputEvent::chunk))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun `random local endpoint descriptor is owner-private and clearable`() {
        val directory = Files.createTempDirectory("holonomy-session-endpoint-store").toFile()
        try {
            val store = AppPrivateSessionCommandStore(directory, MemoryCodec())
            val descriptor = PublishedSessionControlEndpoint(
                protocolVersion = SESSION_CONTROL_PROTOCOL_VERSION,
                processId = 42,
                socketName = "holonomy.session.random",
            )

            store.publishControlEndpoint(descriptor)

            assertEquals(descriptor, store.readControlEndpoint())
            store.clearControlEndpoint("another-socket")
            assertEquals(descriptor, store.readControlEndpoint())
            store.clearControlEndpoint(descriptor.socketName)
            assertNull(store.readControlEndpoint())
        } finally {
            directory.deleteRecursively()
        }
    }
}

private fun acceptedReply(command: SessionCommandV2) = SessionCommandReply(
    ack = SessionCommandAck(
        runtimeId = command.runtimeId,
        commandId = command.commandId,
        command = command.kind,
        generation = 0,
        accepted = true,
    ),
    state = null,
)

private class MemoryCodec(
    private val encodedBytes: Int? = null,
) : SessionControlCodec {
    private val values = ConcurrentHashMap<String, Any>()
    private var sequence = 0

    private fun encode(value: Any): ByteArray {
        val key = "value-${sequence++}"
        values[key] = value
        return encodedBytes?.let { ByteArray(it) { 'x'.code.toByte() } } ?: key.toByteArray()
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> decode(bytes: ByteArray): T = values.getValue(bytes.toString(Charsets.UTF_8)) as T

    override fun encodeCommand(command: SessionCommandV2) = encode(command)
    override fun decodeCommand(bytes: ByteArray): SessionCommandV2 = decode(bytes)
    override fun encodeReply(reply: SessionCommandReply) = encode(reply)
    override fun decodeReply(bytes: ByteArray): SessionCommandReply = decode(bytes)
    override fun encodeState(state: SessionRuntimeSnapshot) = encode(state)
    override fun decodeState(bytes: ByteArray): SessionRuntimeSnapshot = decode(bytes)
    override fun encodeResult(result: SessionExecutionResult) = encode(result)
    override fun decodeResult(bytes: ByteArray): SessionExecutionResult = decode(bytes)
    override fun encodeOutput(output: SessionOutputSnapshot) = encode(output)
    override fun decodeOutput(bytes: ByteArray): SessionOutputSnapshot = decode(bytes)
}
