package ai.oneworks.holonomy.session

import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.ArrayDeque

interface SessionControlCodec {
    fun encodeCommand(command: SessionCommandV2): ByteArray

    fun decodeCommand(bytes: ByteArray): SessionCommandV2

    fun encodeReply(reply: SessionCommandReply): ByteArray

    fun decodeReply(bytes: ByteArray): SessionCommandReply

    fun encodeState(state: SessionRuntimeSnapshot): ByteArray

    fun decodeState(bytes: ByteArray): SessionRuntimeSnapshot

    fun encodeResult(result: SessionExecutionResult): ByteArray

    fun decodeResult(bytes: ByteArray): SessionExecutionResult

    fun encodeOutput(output: SessionOutputSnapshot): ByteArray

    fun decodeOutput(bytes: ByteArray): SessionOutputSnapshot
}

data class SessionCommandStoreLimits(
    val maxArtifactBytes: Int = 64 * 1024 * 1024,
    val maxCommandHistory: Int = 4096,
) {
    init {
        require(maxArtifactBytes in 1..256 * 1024 * 1024)
        require(maxCommandHistory in 1..65_536)
    }
}

data class StoredSessionOutputLimits(
    val maxEvents: Int = 4096,
    val maxBytes: Long = 16 * 1024 * 1024L,
) {
    init {
        require(maxEvents in 1..65_536)
        require(maxBytes in 1..256L * 1024 * 1024)
    }
}

data class PublishedSessionControlEndpoint(
    val protocolVersion: Int,
    val processId: Int,
    val socketName: String,
) {
    init {
        require(protocolVersion == SESSION_CONTROL_PROTOCOL_VERSION)
        require(processId > 0)
        LocalAbstractSessionControlEndpoint(socketName)
    }
}

/**
 * Atomic app-private command journal. The caller must place root below its own Context filesDir;
 * this class never accepts a path supplied by a guest or command payload.
 */
class AppPrivateSessionCommandStore(
    root: File,
    private val codec: SessionControlCodec,
    private val limits: SessionCommandStoreLimits = SessionCommandStoreLimits(),
) {
    private val lock = Any()
    private val root: File
    private val commands: File
    private val replies: File
    private val states: File
    private val results: File
    private val outputs: File
    private val control: File

    init {
        val requestedRoot = root.toPath().toAbsolutePath().normalize()
        require(!Files.isSymbolicLink(requestedRoot)) { "Session store root must not be a symbolic link" }
        this.root = requestedRoot.toFile().canonicalFile
        require(this.root.exists() || this.root.mkdirs()) { "Unable to create session store root" }
        require(this.root.isDirectory) { "Session store root must be a directory" }
        commands = childDirectory("commands")
        replies = childDirectory("replies")
        states = childDirectory("states")
        results = childDirectory("results")
        outputs = childDirectory("outputs")
        control = childDirectory("control")
    }

    /** Returns false only when an identical command is already durably present. */
    fun putCommand(command: SessionCommandV2): Boolean = synchronized(lock) {
        val target = commandFile(command.commandId)
        if (target.exists()) {
            check(codec.decodeCommand(readBounded(target)) == command) { "Command identity collision" }
            false
        } else {
            writeAtomic(target, codec.encodeCommand(command), replace = false)
            true
        }
    }

    fun readCommand(commandId: CommandId): SessionCommandV2? = synchronized(lock) {
        readOptional(commandFile(commandId), codec::decodeCommand)
    }

    fun putReply(reply: SessionCommandReply) = synchronized(lock) {
        val target = replyFile(reply.ack.commandId)
        if (target.exists()) {
            check(codec.decodeReply(readBounded(target)) == reply) { "Reply identity collision" }
        } else {
            writeAtomic(target, codec.encodeReply(reply), replace = false)
        }
        trimCompletedCommandHistory()
    }

    fun readReply(commandId: CommandId): SessionCommandReply? = synchronized(lock) {
        readOptional(replyFile(commandId), codec::decodeReply)
    }

    fun putState(state: SessionRuntimeSnapshot) = synchronized(lock) {
        writeAtomic(stateFile(state.runtimeId), codec.encodeState(state), replace = true)
    }

    fun readState(runtimeId: RuntimeId): SessionRuntimeSnapshot? = synchronized(lock) {
        readOptional(stateFile(runtimeId), codec::decodeState)
    }

    fun putResult(result: SessionExecutionResult) = synchronized(lock) {
        writeAtomic(resultFile(result.runtimeId), codec.encodeResult(result), replace = true)
    }

    fun readResult(runtimeId: RuntimeId): SessionExecutionResult? = synchronized(lock) {
        readOptional(resultFile(runtimeId), codec::decodeResult)
    }

    fun putOutput(output: SessionOutputSnapshot, runtimeId: RuntimeId) = synchronized(lock) {
        require(output.events.all { event -> event.runtimeId == runtimeId }) { "Output runtime mismatch" }
        writeAtomic(outputFile(runtimeId), codec.encodeOutput(output), replace = true)
    }

    fun readOutput(runtimeId: RuntimeId): SessionOutputSnapshot? = synchronized(lock) {
        readOptional(outputFile(runtimeId), codec::decodeOutput)
    }

    fun appendOutput(
        event: SessionOutputEvent,
        outputLimits: StoredSessionOutputLimits = StoredSessionOutputLimits(),
    ) = synchronized(lock) {
        val current = readOptional(outputFile(event.runtimeId), codec::decodeOutput)
        if (current != null) {
            require(event.sequence == current.nextSequence) { "Non-contiguous stored output sequence" }
            require(current.events.all { retained -> retained.runtimeId == event.runtimeId }) {
                "Stored output runtime mismatch"
            }
        }
        val events = ArrayDeque(current?.events.orEmpty())
        var bytes = events.sumOf { retained -> retained.chunk.toByteArray(Charsets.UTF_8).size.toLong() }
        events.addLast(event)
        bytes += event.chunk.toByteArray(Charsets.UTF_8).size
        while (events.size > outputLimits.maxEvents || bytes > outputLimits.maxBytes) {
            bytes -= events.removeFirst().chunk.toByteArray(Charsets.UTF_8).size
        }
        val snapshot = SessionOutputSnapshot(
            firstAvailableSequence = events.firstOrNull()?.sequence ?: event.sequence + 1,
            nextSequence = event.sequence + 1,
            events = events.toList(),
        )
        writeAtomic(outputFile(event.runtimeId), codec.encodeOutput(snapshot), replace = true)
    }

    fun pendingCommands(): List<SessionCommandV2> = synchronized(lock) {
        commands.listFiles().orEmpty()
            .asSequence()
            .filter { file -> file.isFile && file.name.endsWith(COMMAND_SUFFIX) }
            .sortedBy(File::getName)
            .map { file -> codec.decodeCommand(readBounded(file)) }
            .filter { command -> !replyFile(command.commandId).exists() }
            .toList()
    }

    fun publishControlEndpoint(endpoint: PublishedSessionControlEndpoint) = synchronized(lock) {
        val bytes = buildString {
            append(endpoint.protocolVersion).append('\n')
            append(endpoint.processId).append('\n')
            append(endpoint.socketName).append('\n')
        }.toByteArray(Charsets.UTF_8)
        writeAtomic(controlEndpointFile(), bytes, replace = true)
    }

    fun readControlEndpoint(): PublishedSessionControlEndpoint? = synchronized(lock) {
        val file = controlEndpointFile()
        if (!file.exists()) return@synchronized null
        val text = readBounded(file).toString(Charsets.UTF_8)
        require(text.endsWith('\n')) { "Invalid session control endpoint state" }
        val lines = text.dropLast(1).split('\n')
        require(lines.size == 3) { "Invalid session control endpoint state" }
        PublishedSessionControlEndpoint(
            protocolVersion = lines[0].toInt(),
            processId = lines[1].toInt(),
            socketName = lines[2],
        )
    }

    fun clearControlEndpoint(socketName: String) = synchronized(lock) {
        val current = readControlEndpoint()
        if (current?.socketName == socketName) {
            check(controlEndpointFile().delete()) { "Unable to clear session control endpoint" }
        }
    }

    private fun childDirectory(name: String): File {
        val requestedChild = File(root, name)
        require(!Files.isSymbolicLink(requestedChild.toPath())) {
            "Session store directory must not be a symbolic link"
        }
        return requestedChild.canonicalFile.also { child ->
            require(child.parentFile == root) { "Invalid session store directory" }
            require(child.exists() || child.mkdirs()) { "Unable to create session store directory" }
            require(child.isDirectory) { "Session store child must be a directory" }
        }
    }

    private fun commandFile(commandId: CommandId) = File(commands, "${commandId.value}$COMMAND_SUFFIX")

    private fun replyFile(commandId: CommandId) = File(replies, "${commandId.value}$REPLY_SUFFIX")

    private fun stateFile(runtimeId: RuntimeId) = File(states, "${runtimeId.value}$STATE_SUFFIX")

    private fun resultFile(runtimeId: RuntimeId) = File(results, "${runtimeId.value}$RESULT_SUFFIX")

    private fun outputFile(runtimeId: RuntimeId) = File(outputs, "${runtimeId.value}$OUTPUT_SUFFIX")

    private fun controlEndpointFile() = File(control, CONTROL_ENDPOINT_FILE)

    private fun trimCompletedCommandHistory() {
        val completed = commands.listFiles().orEmpty()
            .asSequence()
            .filter { file -> file.isFile && file.name.endsWith(COMMAND_SUFFIX) }
            .mapNotNull { command ->
                val commandId = CommandId(command.name.removeSuffix(COMMAND_SUFFIX))
                val reply = replyFile(commandId)
                if (reply.isFile && !Files.isSymbolicLink(reply.toPath())) command to reply else null
            }
            .sortedWith(compareBy({ (_, reply) -> Files.getLastModifiedTime(reply.toPath()) }, { (_, reply) -> reply.name }))
            .toList()
        completed.take((completed.size - limits.maxCommandHistory).coerceAtLeast(0))
            .forEach { (command, reply) ->
                check(reply.delete()) { "Unable to evict completed session reply" }
                check(command.delete()) { "Unable to evict completed session command" }
            }
    }

    private fun <T> readOptional(file: File, decode: (ByteArray) -> T): T? =
        if (file.exists()) decode(readBounded(file)) else null

    private fun readBounded(file: File): ByteArray {
        require(file.isFile && !Files.isSymbolicLink(file.toPath())) { "Invalid session store artifact" }
        require(file.length() in 1..limits.maxArtifactBytes.toLong()) { "Session store artifact exceeds the limit" }
        return file.readBytes().also { bytes ->
            require(bytes.size <= limits.maxArtifactBytes) { "Session store artifact exceeds the limit" }
        }
    }

    private fun writeAtomic(target: File, bytes: ByteArray, replace: Boolean) {
        require(bytes.isNotEmpty() && bytes.size <= limits.maxArtifactBytes) {
            "Session store artifact exceeds the limit"
        }
        val parent = requireNotNull(target.parentFile)
        require(parent in setOf(commands, replies, states, results, outputs, control)) {
            "Session store target escaped its directory"
        }
        val temporary = File(parent, ".${target.name}.${Thread.currentThread().id}.tmp")
        check(!temporary.exists()) { "Session store temporary file collision" }
        try {
            FileOutputStream(temporary).use { output ->
                output.write(bytes)
                output.fd.sync()
            }
            check(temporary.setReadable(false, false) && temporary.setReadable(true, true)) {
                "Unable to restrict session artifact reads"
            }
            check(temporary.setWritable(false, false) && temporary.setWritable(true, true)) {
                "Unable to restrict session artifact writes"
            }
            temporary.setExecutable(false, false)
            val options = if (replace) {
                arrayOf(StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } else {
                arrayOf(StandardCopyOption.ATOMIC_MOVE)
            }
            try {
                Files.move(temporary.toPath(), target.toPath(), *options)
            } catch (_: AtomicMoveNotSupportedException) {
                val fallback = if (replace) {
                    arrayOf(StandardCopyOption.REPLACE_EXISTING)
                } else {
                    emptyArray<StandardCopyOption>()
                }
                Files.move(temporary.toPath(), target.toPath(), *fallback)
            }
        } finally {
            if (temporary.exists()) check(temporary.delete()) { "Unable to remove temporary session artifact" }
        }
    }

    private companion object {
        private const val CONTROL_ENDPOINT_FILE = "endpoint.v2"
        private const val COMMAND_SUFFIX = ".command"
        private const val OUTPUT_SUFFIX = ".output"
        private const val REPLY_SUFFIX = ".reply"
        private const val RESULT_SUFFIX = ".result"
        private const val STATE_SUFFIX = ".state"
    }
}
