package ai.oneworks.holonomy.v86

internal data class AndroidV86StdinCommand(
    val operation: String,
    val bytes: ByteArray? = null,
    val callbackId: Long? = null,
)

internal sealed interface AndroidV86StdinAdmission {
    data class Accepted(val immediateCallbackId: Long? = null) : AndroidV86StdinAdmission

    data class Rejected(val code: String) : AndroidV86StdinAdmission
}

/**
 * Serializes stdin operations issued before and after the Linux spawn event.
 *
 * Node exposes ChildProcess.stdin immediately, so a write or end can arrive before the Backend has
 * assigned a Linux PID. The queue preserves admission order across that boundary and never invokes
 * the supplied dispatcher concurrently.
 */
internal class AndroidV86StdinQueue(
    private val maximumBytes: Long,
) {
    private val callbackIds = mutableSetOf<Long>()
    private val commands = ArrayDeque<AndroidV86StdinCommand>()
    private var byteCount = 0L
    private var closed = false
    private var ended = false
    private var processId: Int? = null
    private var ready = false

    @Synchronized
    fun write(
        bytes: ByteArray,
        callbackId: Long?,
        dispatch: (Int, AndroidV86StdinCommand) -> Unit,
    ): AndroidV86StdinAdmission {
        if (closed || ended) return AndroidV86StdinAdmission.Rejected("resource.stale")
        if (byteCount + bytes.size > maximumBytes) {
            return AndroidV86StdinAdmission.Rejected("resource.byte_limit")
        }
        if (callbackId != null && !callbackIds.add(callbackId)) {
            return AndroidV86StdinAdmission.Rejected("argument.invalid")
        }
        val command = AndroidV86StdinCommand("stdin", bytes.copyOf(), callbackId)
        byteCount += bytes.size
        return admit(command, dispatch) {
            byteCount -= bytes.size
            callbackId?.let(callbackIds::remove)
        }
    }

    @Synchronized
    fun end(
        callbackId: Long?,
        dispatch: (Int, AndroidV86StdinCommand) -> Unit,
    ): AndroidV86StdinAdmission {
        if (closed) return AndroidV86StdinAdmission.Rejected("resource.stale")
        if (callbackId != null && !callbackIds.add(callbackId)) {
            return AndroidV86StdinAdmission.Rejected("argument.invalid")
        }
        if (ended) {
            callbackId?.let(callbackIds::remove)
            return AndroidV86StdinAdmission.Accepted(callbackId)
        }
        ended = true
        return admit(AndroidV86StdinCommand("end", callbackId = callbackId), dispatch) {
            ended = false
            callbackId?.let(callbackIds::remove)
        }
    }

    @Synchronized
    fun attachProcess(
        value: Int,
        dispatch: (Int, AndroidV86StdinCommand) -> Unit,
    ): Throwable? {
        if (closed || processId != null) return IllegalStateException("stdin process is not attachable")
        processId = value
        return runCatching {
            commands.forEach { command -> dispatch(value, command) }
            commands.clear()
            ready = true
        }.exceptionOrNull()
    }

    @Synchronized
    fun acknowledge(callbackId: Long): Boolean = callbackIds.remove(callbackId)

    @Synchronized
    fun close(): List<Long> {
        if (closed) return emptyList()
        closed = true
        ready = false
        commands.clear()
        return callbackIds.toList().also { callbackIds.clear() }
    }

    private fun admit(
        command: AndroidV86StdinCommand,
        dispatch: (Int, AndroidV86StdinCommand) -> Unit,
        rollback: () -> Unit,
    ): AndroidV86StdinAdmission {
        val pid = processId
        if (!ready || pid == null) {
            commands.addLast(command)
            return AndroidV86StdinAdmission.Accepted()
        }
        return runCatching { dispatch(pid, command) }
            .fold(
                onSuccess = { AndroidV86StdinAdmission.Accepted() },
                onFailure = {
                    rollback()
                    AndroidV86StdinAdmission.Rejected("provider.unavailable")
                },
            )
    }
}
