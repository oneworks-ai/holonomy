package ai.oneworks.holonomy.v86

internal data class AndroidV86StdinCommand(
    val operation: String,
    val sequence: Long,
    val bytes: ByteArray? = null,
    val callbackId: Long? = null,
)

internal data class AndroidV86StdinCompletion(
    val callbackId: Long?,
    val dispatchFailed: Boolean,
)

internal sealed interface AndroidV86StdinAdmission {
    data class Accepted(val immediateCallbackId: Long? = null) : AndroidV86StdinAdmission

    data class Rejected(val code: String) : AndroidV86StdinAdmission
}

/**
 * Serializes stdin operations issued before and after the Linux spawn event.
 *
 * Node exposes ChildProcess.stdin immediately, so a write or end can arrive before the Backend has
 * assigned a Linux PID. The supervisor accepts only one pending stdin frame, so the queue waits
 * for the matching Backend ACK or error before sending the next command. The Host-owned sequence
 * also fences duplicate and late events for writes without a JavaScript callback.
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
    private var nextSequence = 1L
    private var inFlight: AndroidV86StdinCommand? = null
    private var dispatching = false

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
        val command = AndroidV86StdinCommand("stdin", nextSequence++, bytes.copyOf(), callbackId)
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
        return admit(AndroidV86StdinCommand("end", nextSequence++, callbackId = callbackId), dispatch) {
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
        ready = true
        return runCatching {
            dispatchNext(dispatch)
        }.exceptionOrNull().also { if (it != null) ready = false }
    }

    @Synchronized
    fun acknowledge(
        sequence: Long,
        operation: String,
        callbackId: Long?,
        dispatch: (Int, AndroidV86StdinCommand) -> Unit,
    ): AndroidV86StdinCompletion? {
        val command = inFlight ?: return null
        if (
            closed || command.sequence != sequence || command.operation != operation ||
            command.callbackId != callbackId
        ) return null
        inFlight = null
        command.callbackId?.let(callbackIds::remove)
        val failed = runCatching { dispatchNext(dispatch) }.isFailure
        if (failed) ready = false
        return AndroidV86StdinCompletion(command.callbackId, failed)
    }

    @Synchronized
    fun close(): List<Long> {
        if (closed) return emptyList()
        closed = true
        ready = false
        inFlight = null
        commands.clear()
        return callbackIds.toList().also { callbackIds.clear() }
    }

    private fun admit(
        command: AndroidV86StdinCommand,
        dispatch: (Int, AndroidV86StdinCommand) -> Unit,
        rollback: () -> Unit,
    ): AndroidV86StdinAdmission {
        commands.addLast(command)
        return runCatching { dispatchNext(dispatch) }
            .fold(
                onSuccess = { AndroidV86StdinAdmission.Accepted() },
                onFailure = {
                    rollback()
                    AndroidV86StdinAdmission.Rejected("provider.unavailable")
                },
            )
    }

    private fun dispatchNext(dispatch: (Int, AndroidV86StdinCommand) -> Unit) {
        if (dispatching || closed || !ready || inFlight != null) return
        val pid = processId ?: return
        dispatching = true
        try {
            while (!closed && ready && inFlight == null && commands.isNotEmpty()) {
                val command = commands.removeFirst()
                inFlight = command
                try {
                    dispatch(pid, command)
                } catch (error: Throwable) {
                    if (inFlight === command) inFlight = null
                    throw error
                }
            }
        } finally {
            dispatching = false
        }
    }
}
