package ai.oneworks.holonomy.session

import java.util.concurrent.CompletableFuture

/**
 * Typed integration facade for an in-process supervisor or a transport-backed command handler.
 * Command IDs remain caller-owned so retries preserve their idempotency identity.
 */
class AndroidRuntimeSessionController(
    private val handler: SessionCommandHandler,
) {
    constructor(supervisor: AndroidRuntimeSessionSupervisor) : this(supervisor::execute)

    fun create(command: CreateRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun start(command: StartRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun status(command: StatusRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun cancel(command: CancelRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun stop(command: StopRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun restart(command: RestartRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun control(command: ControlRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)

    fun dispose(command: DisposeRuntimeCommand): CompletableFuture<SessionCommandReply> = handler.handle(command)
}
