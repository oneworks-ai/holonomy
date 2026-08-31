package ai.oneworks.holonomy.e2e.session.supervisor

import android.content.Context
import android.os.SystemClock
import ai.oneworks.holonomy.e2e.INSTRUMENTATION_POLL_INTERVAL_MS
import ai.oneworks.holonomy.e2e.INSTRUMENTATION_TIMEOUT_SECONDS
import ai.oneworks.holonomy.session.AppPrivateSessionCommandStore
import ai.oneworks.holonomy.session.CommandId
import ai.oneworks.holonomy.session.CreateRuntimeCommand
import ai.oneworks.holonomy.session.DisposeRuntimeCommand
import ai.oneworks.holonomy.session.HolonomySessionCommandIngress
import ai.oneworks.holonomy.session.HolonomySessionSupervisorService
import ai.oneworks.holonomy.session.JsonSessionControlCodec
import ai.oneworks.holonomy.session.RuntimeId
import ai.oneworks.holonomy.session.SessionCommandReply
import ai.oneworks.holonomy.session.SessionCommandV2
import ai.oneworks.holonomy.session.SessionIngressCommandIds
import ai.oneworks.holonomy.session.SessionOutputSnapshot
import ai.oneworks.holonomy.session.SessionRuntimeSpec
import ai.oneworks.holonomy.session.SessionRuntimeSnapshot
import ai.oneworks.holonomy.session.StartRuntimeCommand
import ai.oneworks.holonomy.session.StatusRuntimeCommand
import java.io.File
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertTrue

internal class SessionSupervisorInstrumentationHarness(
    context: Context,
) : AutoCloseable {
    private val context = context.applicationContext
    private val ingress = HolonomySessionCommandIngress(this.context)
    private val store = AppPrivateSessionCommandStore(
        File(
            this.context.noBackupFilesDir,
            HolonomySessionSupervisorService.APP_PRIVATE_STORE_DIRECTORY,
        ),
        JsonSessionControlCodec(),
    )
    private val activeGenerations = linkedMapOf<RuntimeId, Long>()

    fun runtimeId(prefix: String): RuntimeId = RuntimeId("$prefix-${commandId().value.take(12)}")

    fun commandId(): CommandId = SessionIngressCommandIds.random()

    fun create(runtimeId: RuntimeId, spec: SessionRuntimeSpec): SessionCommandReply {
        val reply = execute(CreateRuntimeCommand(runtimeId, commandId(), spec))
        if (reply.ack.accepted) activeGenerations[runtimeId] = reply.ack.generation
        return reply
    }

    fun start(
        runtimeId: RuntimeId,
        timeoutSeconds: Long = INSTRUMENTATION_TIMEOUT_SECONDS,
    ): SessionCommandReply {
        val generation = activeGenerations.getValue(runtimeId)
        val reply = awaitReply(submit(StartRuntimeCommand(runtimeId, commandId(), generation)), timeoutSeconds)
        if (reply.ack.accepted) activeGenerations[runtimeId] = reply.ack.generation
        return reply
    }

    fun submit(command: SessionCommandV2): CommandId {
        assertTrue("A fresh instrumentation commandId collided", ingress.submit(command))
        return command.commandId
    }

    fun stage(command: SessionCommandV2): CommandId {
        assertTrue("A fresh staged commandId collided", store.putCommand(command))
        return command.commandId
    }

    fun execute(command: SessionCommandV2): SessionCommandReply = awaitReply(submit(command))

    fun execute(command: SessionCommandV2, timeoutSeconds: Long): SessionCommandReply =
        awaitReply(submit(command), timeoutSeconds)

    fun awaitReply(
        commandId: CommandId,
        timeoutSeconds: Long = INSTRUMENTATION_TIMEOUT_SECONDS,
    ): SessionCommandReply = await(
        description = "reply for $commandId",
        read = { ingress.readReply(commandId) },
        predicate = { true },
        timeoutSeconds = timeoutSeconds,
    )

    fun awaitOutput(
        runtimeId: RuntimeId,
        description: String,
        timeoutSeconds: Long = INSTRUMENTATION_TIMEOUT_SECONDS,
        predicate: (SessionOutputSnapshot) -> Boolean,
    ): SessionOutputSnapshot = await(
        description = description,
        read = {
            execute(
                StatusRuntimeCommand(
                    runtimeId,
                    commandId(),
                    activeGenerations.getValue(runtimeId),
                ),
            ).output
        },
        predicate = predicate,
        pollIntervalMs = OUTPUT_POLL_INTERVAL_MS,
        timeoutSeconds = timeoutSeconds,
    )

    fun awaitState(
        runtimeId: RuntimeId,
        generation: Long,
        description: String,
        predicate: (SessionRuntimeSnapshot) -> Boolean,
    ): SessionRuntimeSnapshot = await(
        description = description,
        read = {
            execute(StatusRuntimeCommand(runtimeId, commandId(), generation)).state
        },
        predicate = predicate,
        pollIntervalMs = OUTPUT_POLL_INTERVAL_MS,
    )

    fun track(runtimeId: RuntimeId, generation: Long) {
        activeGenerations[runtimeId] = generation
    }

    fun forget(runtimeId: RuntimeId) {
        activeGenerations.remove(runtimeId)
    }

    override fun close() {
        activeGenerations.toList().asReversed().forEach { (runtimeId, generation) ->
            runCatching {
                execute(DisposeRuntimeCommand(runtimeId, commandId(), generation))
            }
        }
        activeGenerations.clear()
    }

    private fun <T : Any> await(
        description: String,
        read: () -> T?,
        predicate: (T) -> Boolean,
        pollIntervalMs: Long = INSTRUMENTATION_POLL_INTERVAL_MS,
        timeoutSeconds: Long = INSTRUMENTATION_TIMEOUT_SECONDS,
    ): T {
        val deadline = SystemClock.elapsedRealtime() +
            TimeUnit.SECONDS.toMillis(timeoutSeconds)
        var value = read()
        while ((value == null || !predicate(value)) && SystemClock.elapsedRealtime() < deadline) {
            SystemClock.sleep(pollIntervalMs)
            value = read()
        }
        return requireNotNull(value?.takeIf(predicate)) { "Timed out waiting for $description; last=$value" }
    }

    private companion object {
        private const val OUTPUT_POLL_INTERVAL_MS = 50L
    }
}
