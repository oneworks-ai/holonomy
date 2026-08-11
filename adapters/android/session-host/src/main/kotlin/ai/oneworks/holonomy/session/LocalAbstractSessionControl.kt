package ai.oneworks.holonomy.session

import java.util.concurrent.CompletableFuture

data class LocalAbstractSessionControlEndpoint(
    val socketName: String,
    val maxMessageBytes: Int = 1024 * 1024,
) {
    init {
        require(SOCKET_NAME.matches(socketName)) { "Invalid local-abstract control socket name" }
        require(maxMessageBytes in 1024..64 * 1024 * 1024) { "Invalid control message limit" }
    }

    private companion object {
        private val SOCKET_NAME = Regex("[A-Za-z0-9._-]{1,96}")
    }
}

fun interface SessionCommandHandler {
    fun handle(command: SessionCommandV2): CompletableFuture<SessionCommandReply>
}

/**
 * Android integration implements this with LocalServerSocket. The transport owns framing and
 * message quotas only; command semantics remain in AndroidRuntimeSessionSupervisor.
 */
interface LocalAbstractSessionControlTransport : AutoCloseable {
    val endpoint: LocalAbstractSessionControlEndpoint

    fun start(handler: SessionCommandHandler)

    override fun close()
}

fun interface LocalAbstractSessionControlTransportFactory {
    fun create(endpoint: LocalAbstractSessionControlEndpoint): LocalAbstractSessionControlTransport
}

/** Persists command/reply artifacts while leaving typed execution to the supervisor. */
class StoredSessionCommandHandler(
    private val supervisor: AndroidRuntimeSessionSupervisor,
    private val store: AppPrivateSessionCommandStore,
) : SessionCommandHandler {
    override fun handle(command: SessionCommandV2): CompletableFuture<SessionCommandReply> {
        val inserted = store.putCommand(command)
        if (!inserted) {
            val reply = store.readReply(command.commandId)
            if (reply != null) return CompletableFuture.completedFuture(reply)
        }
        return supervisor.execute(command).thenApply { reply ->
            store.putReply(reply)
            reply.state?.let(store::putState)
            reply.result?.let(store::putResult)
            reply.output?.let { output -> store.putOutput(output, command.runtimeId) }
            reply
        }
    }
}

/** Persists state, result, and bounded output snapshots emitted outside command completion. */
class StoredSessionSupervisorEventSink(
    private val store: AppPrivateSessionCommandStore,
    private val outputLimits: StoredSessionOutputLimits = StoredSessionOutputLimits(),
) : SessionSupervisorEventSink {
    override fun onState(snapshot: SessionRuntimeSnapshot) = store.putState(snapshot)

    override fun onOutput(event: SessionOutputEvent) = store.appendOutput(event, outputLimits)

    override fun onResult(result: SessionExecutionResult) = store.putResult(result)
}
