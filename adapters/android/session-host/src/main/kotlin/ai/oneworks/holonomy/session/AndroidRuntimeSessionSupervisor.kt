package ai.oneworks.holonomy.session

import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.host.RuntimeProcessConfiguration
import ai.oneworks.holonomy.host.RuntimeProcessHost
import java.lang.ref.WeakReference
import java.util.ArrayDeque
import java.util.concurrent.CompletableFuture

data class SessionSupervisorLimits(
    val maxRuntimes: Int = 8,
    val maxCommandHistory: Int = 4096,
    val maxOutputBytes: Long = 16 * 1024 * 1024L,
    val maxOutputChunkBytes: Int = 1024 * 1024,
    val maxOutputEvents: Int = 4096,
) {
    init {
        require(maxRuntimes in 1..128)
        require(maxCommandHistory in 1..65_536)
        require(maxOutputBytes in 1..256L * 1024 * 1024)
        require(maxOutputChunkBytes in 1..16 * 1024 * 1024)
        require(maxOutputEvents in 1..65_536)
    }
}

interface SessionSupervisorEventSink {
    fun onState(snapshot: SessionRuntimeSnapshot) = Unit

    fun onOutput(event: SessionOutputEvent) = Unit

    fun onResult(result: SessionExecutionResult) = Unit
}

object SilentSessionSupervisorEventSink : SessionSupervisorEventSink

/**
 * Owns logical runtime instances only. Android Service/component lifetime and command transport
 * are application integration concerns layered on top of this supervisor.
 */
class AndroidRuntimeSessionSupervisor(
    private val runtimeFactory: SessionRuntimeFactory,
    private val nativeHostFactory: SessionNativeHostFactory,
    private val eventSink: SessionSupervisorEventSink = SilentSessionSupervisorEventSink,
    private val limits: SessionSupervisorLimits = SessionSupervisorLimits(),
) : AutoCloseable {
    private val lock = Any()
    private val runtimes = LinkedHashMap<RuntimeId, RuntimeRecord>()
    private val commands = LinkedHashMap<CommandId, CommandExecution>()
    private val issuedNativeHosts = mutableListOf<WeakReference<RuntimeNativeHost>>()
    private val processId = currentProcessId()
    private var closed = false

    fun execute(command: SessionCommandV2): CompletableFuture<SessionCommandReply> {
        synchronized(lock) {
            commands[command.commandId]?.let { existing ->
                return if (existing.command == command) {
                    existing.future
                } else {
                    completedReply(rejectedReply(command, SessionControlErrorCode.COMMAND_CONFLICT))
                }
            }
            evictCompletedCommandHistoryForAdmission()
            if (commands.size >= limits.maxCommandHistory) {
                return completedReply(rejectedReply(command, SessionControlErrorCode.LIMIT_EXCEEDED))
            }
            val future = CompletableFuture<SessionCommandReply>()
            commands[command.commandId] = CommandExecution(command, future)
            if (closed) {
                future.complete(rejectedReply(command, SessionControlErrorCode.INVALID_STATE))
                return future
            }
            when (command) {
                is CreateRuntimeCommand -> create(command, future)
                is StartRuntimeCommand -> start(command, future)
                is StatusRuntimeCommand -> status(command, future)
                is CancelRuntimeCommand -> cancel(command, future)
                is StopRuntimeCommand -> stop(command, future)
                is RestartRuntimeCommand -> restart(command, future)
                is ControlRuntimeCommand -> control(command, future)
                is DisposeRuntimeCommand -> dispose(command, future)
            }
            return future
        }
    }

    fun snapshots(): List<SessionRuntimeSnapshot> = synchronized(lock) {
        runtimes.values.map(::snapshot)
    }

    private fun evictCompletedCommandHistoryForAdmission() {
        while (commands.size >= limits.maxCommandHistory) {
            val oldestCompleted = commands.entries.firstOrNull { (_, execution) -> execution.future.isDone }
                ?: return
            commands.remove(oldestCompleted.key)
        }
    }

    override fun close() {
        val engines = synchronized(lock) {
            if (closed) return
            closed = true
            runtimes.values.mapNotNull { record ->
                settlePendingGenerationCommand(record)
                record.engine.also { record.engine = null }
                    .also { record.control = null }
            }.also {
                for (record in runtimes.values) {
                    record.phase = SessionRuntimePhase.DISPOSED
                    publishState(record)
                }
                commands.values
                    .filterNot { execution -> execution.future.isDone }
                    .forEach { execution ->
                        execution.future.complete(
                            rejectedReply(execution.command, SessionControlErrorCode.INVALID_STATE),
                        )
                    }
            }
        }
        engines.forEach { engine -> runCatching { engine.dispose() } }
    }

    private fun create(
        command: CreateRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        if (command.spec.isolation == SessionIsolation.ISOLATED_PROCESS) {
            future.complete(rejectedReply(command, SessionControlErrorCode.ISOLATION_UNSUPPORTED))
            return
        }
        if (command.spec.sandboxPolicy.filesystem.access != SessionSandboxFilesystemAccess.NONE) {
            future.complete(rejectedReply(command, SessionControlErrorCode.SANDBOX_CAPABILITY_UNSUPPORTED))
            return
        }
        if (runtimes.containsKey(command.runtimeId)) {
            future.complete(rejectedReply(command, SessionControlErrorCode.ALREADY_EXISTS))
            return
        }
        if (runtimes.values.count { it.phase != SessionRuntimePhase.DISPOSED } >= limits.maxRuntimes) {
            future.complete(rejectedReply(command, SessionControlErrorCode.LIMIT_EXCEEDED))
            return
        }
        val record = RuntimeRecord(command.runtimeId, command.spec)
        runtimes[command.runtimeId] = record
        publishState(record)
        future.complete(acceptedReply(command, record))
    }

    private fun start(
        command: StartRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        val record = requireRecord(command, future) ?: return
        if (record.phase !in setOf(SessionRuntimePhase.CREATED, SessionRuntimePhase.STOPPED)) {
            future.complete(rejectedReply(command, SessionControlErrorCode.INVALID_STATE, record))
            return
        }
        beginGeneration(command, record, future, SessionRuntimePhase.STARTING, null)
    }

    private fun status(
        command: StatusRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        val record = requireRecord(command, future) ?: return
        future.complete(
            acceptedReply(
                command,
                record,
                output = outputSnapshot(record, command.afterOutputSequence),
            ),
        )
    }

    private fun cancel(
        command: CancelRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        finishGeneration(
            command = command,
            future = future,
            transition = SessionRuntimePhase.CANCELING,
            terminal = SessionRuntimePhase.CANCELED,
            exitCode = CANCEL_EXIT_CODE,
            reason = command.reason ?: "Runtime session cancelled",
        )
    }

    private fun stop(
        command: StopRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        finishGeneration(
            command = command,
            future = future,
            transition = SessionRuntimePhase.STOPPING,
            terminal = SessionRuntimePhase.STOPPED,
            exitCode = STOP_EXIT_CODE,
            reason = command.reason ?: "Runtime session stopped",
        )
    }

    private fun restart(
        command: RestartRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        val record = requireRecord(command, future) ?: return
        if (record.phase in setOf(SessionRuntimePhase.CREATED, SessionRuntimePhase.DISPOSING, SessionRuntimePhase.DISPOSED)) {
            future.complete(rejectedReply(command, SessionControlErrorCode.INVALID_STATE, record))
            return
        }
        settlePendingGenerationCommand(record)
        val oldEngine = record.engine
        record.engine = null
        record.control = null
        record.currentProcessHost = null
        record.generation += 1
        record.phase = SessionRuntimePhase.RESTARTING
        record.result = null
        publishState(record)
        val generation = record.generation
        record.pendingGenerationCommand = PendingGenerationCommand(command, future, generation)
        val disposal = oldEngine?.dispose() ?: CompletableFuture.completedFuture(Unit)
        disposal.whenComplete { _, error ->
            if (error != null) {
                failGeneration(command, record, generation, future)
            } else {
                createAndStartEngine(command, record, generation, future)
            }
        }
    }

    private fun dispose(
        command: DisposeRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        val record = requireRecord(command, future) ?: return
        if (record.phase == SessionRuntimePhase.DISPOSED) {
            future.complete(acceptedReply(command, record))
            return
        }
        settlePendingGenerationCommand(record)
        record.phase = SessionRuntimePhase.DISPOSING
        val engine = record.engine
        record.engine = null
        record.control = null
        record.currentProcessHost = null
        publishState(record)
        val generation = record.generation
        val disposal = engine?.dispose() ?: CompletableFuture.completedFuture(Unit)
        disposal.whenComplete { _, error ->
            synchronized(lock) {
                if (record.generation != generation || record.phase != SessionRuntimePhase.DISPOSING) return@synchronized
                record.phase = if (error == null) SessionRuntimePhase.DISPOSED else SessionRuntimePhase.FAILED
                if (error != null) record.result = SessionExecutionResult(record.runtimeId, generation, 1, "Runtime disposal failed")
                publishState(record)
                record.result?.let(::publishResult)
                future.complete(acceptedReply(command, record))
            }
        }
    }

    private fun finishGeneration(
        command: SessionCommandV2,
        future: CompletableFuture<SessionCommandReply>,
        transition: SessionRuntimePhase,
        terminal: SessionRuntimePhase,
        exitCode: Int,
        reason: String,
    ) {
        val record = requireRecord(command, future) ?: return
        if (record.phase !in ACTIVE_PHASES) {
            future.complete(rejectedReply(command, SessionControlErrorCode.INVALID_STATE, record))
            return
        }
        settlePendingGenerationCommand(record)
        val engine = record.engine
        val generation = record.generation
        record.phase = transition
        record.engine = null
        record.control = null
        record.currentProcessHost = null
        publishState(record)
        val disposal = engine?.dispose() ?: CompletableFuture.completedFuture(Unit)
        disposal.whenComplete { _, error ->
            synchronized(lock) {
                if (record.generation != generation || record.phase != transition) return@synchronized
                record.phase = if (error == null) terminal else SessionRuntimePhase.FAILED
                record.result = SessionExecutionResult(
                    record.runtimeId,
                    generation,
                    if (error == null) exitCode else 1,
                    if (error == null) reason else "Runtime disposal failed",
                )
                publishState(record)
                publishResult(requireNotNull(record.result))
                future.complete(acceptedReply(command, record))
            }
        }
    }

    private fun beginGeneration(
        command: SessionCommandV2,
        record: RuntimeRecord,
        future: CompletableFuture<SessionCommandReply>,
        phase: SessionRuntimePhase,
        oldEngine: RuntimeEngine?,
    ) {
        settlePendingGenerationCommand(record)
        record.generation += 1
        record.phase = phase
        record.result = null
        record.engine = null
        record.control = null
        record.currentProcessHost = null
        publishState(record)
        val generation = record.generation
        record.pendingGenerationCommand = PendingGenerationCommand(command, future, generation)
        val disposal = oldEngine?.dispose() ?: CompletableFuture.completedFuture(Unit)
        disposal.whenComplete { _, error ->
            if (error != null) failGeneration(command, record, generation, future)
            else createAndStartEngine(command, record, generation, future)
        }
    }

    private fun createAndStartEngine(
        command: SessionCommandV2,
        record: RuntimeRecord,
        generation: Long,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        val setup = synchronized(lock) {
            if (closed || record.generation != generation || record.phase !in STARTING_PHASES) return
            runCatching {
                val graph = SessionModuleGraph(record.spec)
                val processHost = SupervisorProcessHost(record, generation)
                val principal = generationPrincipal(record.runtimeId, generation)
                val context = SessionRuntimeContext(
                    runtimeId = record.runtimeId,
                    generation = generation,
                    spec = record.spec,
                    processHost = processHost,
                    moduleResolver = graph.resolver,
                    sandboxPolicyDigest = record.spec.sandboxPolicy.digest,
                    principal = principal,
                    freshNativeHostFactory = freshNativeHostFactory(record, generation, principal),
                )
                val instance = runtimeFactory.create(context)
                val engine = instance.engine
                record.engine = engine
                record.control = instance.control
                record.currentProcessHost = processHost
                EngineSetup(engine, instance.control, graph.entry, processHost)
            }
        }
        val (engine, control, entry, processHost) = setup.getOrElse {
            failGeneration(command, record, generation, future)
            return
        }
        engine.start()
            .thenCompose { applyInitialControls(control, record.spec.initialControls) }
            .thenCompose { engine.executeModule(entry) }
            .whenComplete { _, error ->
                var disposeEngine = false
                synchronized(lock) {
                    if (
                        record.generation != generation ||
                        record.currentProcessHost !== processHost ||
                        record.engine !== engine
                    ) return@synchronized
                    if (error == null) {
                        if (record.phase in STARTING_PHASES) {
                            record.phase = SessionRuntimePhase.RUNNING
                            publishState(record)
                        }
                    } else {
                        record.engine = null
                        record.control = null
                        record.currentProcessHost = null
                        record.phase = SessionRuntimePhase.FAILED
                        record.result = SessionExecutionResult(record.runtimeId, generation, 1, "Runtime failed to start")
                        publishState(record)
                        publishResult(requireNotNull(record.result))
                        disposeEngine = true
                    }
                    completePendingGenerationCommand(record, command, future, generation)
                }
                if (disposeEngine) runCatching { engine.dispose() }
            }
    }

    private fun failGeneration(
        command: SessionCommandV2,
        record: RuntimeRecord,
        generation: Long,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        synchronized(lock) {
            if (record.generation != generation) return
            record.engine = null
            record.control = null
            record.currentProcessHost = null
            record.phase = SessionRuntimePhase.FAILED
            record.result = SessionExecutionResult(record.runtimeId, generation, 1, "Runtime failed to start")
            publishState(record)
            publishResult(requireNotNull(record.result))
            completePendingGenerationCommand(record, command, future, generation)
        }
    }

    private fun freshNativeHostFactory(
        record: RuntimeRecord,
        generation: Long,
        principal: String,
    ): () -> RuntimeNativeHost = {
        synchronized(lock) {
            check(!closed && record.generation == generation && record.phase !in TERMINAL_PHASES) {
                "The runtime generation is inactive"
            }
            val hostGeneration = ++record.nativeHostGeneration
            val host = nativeHostFactory.create(
                SessionNativeHostContext(
                    runtimeId = record.runtimeId,
                    runtimeGeneration = generation,
                    nativeHostGeneration = hostGeneration,
                    sandboxPolicy = record.spec.sandboxPolicy,
                    sandboxPolicyDigest = record.spec.sandboxPolicy.digest,
                    principal = principal,
                ),
            )
            issuedNativeHosts.removeAll { reference -> reference.get() == null }
            check(issuedNativeHosts.none { reference -> reference.get() === host }) {
                "SessionNativeHostFactory must return a fresh identity"
            }
            issuedNativeHosts += WeakReference(host)
            host
        }
    }

    private fun onProcessOutput(
        record: RuntimeRecord,
        processHost: SupervisorProcessHost,
        generation: Long,
        stream: SessionOutputStream,
        chunk: String,
    ) {
        if (chunk.isEmpty()) return
        val event = synchronized(lock) {
            if (!isCurrentExecution(record, processHost, generation)) return
            val bytes = chunk.toByteArray(Charsets.UTF_8).size
            if (bytes > limits.maxOutputChunkBytes) {
                null
            } else {
                SessionOutputEvent(
                    runtimeId = record.runtimeId,
                    generation = generation,
                    sequence = record.nextOutputSequence++,
                    stream = stream,
                    chunk = chunk,
                ).also { output ->
                    record.outputEvents += OutputRecord(output, bytes)
                    record.outputBytes += bytes
                    trimOutput(record)
                }
            }
        }
        if (event == null) {
            onProcessExit(record, processHost, generation, 1, "Runtime output limit exceeded")
        } else {
            publishOutput(event)
        }
    }

    private fun onProcessExit(
        record: RuntimeRecord,
        processHost: SupervisorProcessHost,
        generation: Long,
        exitCode: Int,
        reason: String? = null,
    ) {
        val engine = synchronized(lock) {
            if (!isCurrentExecution(record, processHost, generation)) return
            val normalizedCode = exitCode.coerceIn(0, 255)
            record.currentProcessHost = null
            record.engine.also { record.engine = null }
                .also { record.control = null }
                .also {
                    record.phase = if (normalizedCode == 0) {
                        SessionRuntimePhase.COMPLETED
                    } else {
                        SessionRuntimePhase.FAILED
                    }
                    record.result = SessionExecutionResult(record.runtimeId, generation, normalizedCode, reason)
                    publishState(record)
                    publishResult(requireNotNull(record.result))
                    settlePendingGenerationCommand(record)
                }
        }
        engine?.dispose()
    }

    private fun isCurrentExecution(
        record: RuntimeRecord,
        processHost: SupervisorProcessHost,
        generation: Long,
    ): Boolean =
        !closed &&
            record.generation == generation &&
            record.currentProcessHost === processHost &&
            record.phase in ACTIVE_PHASES

    private fun control(
        command: ControlRuntimeCommand,
        future: CompletableFuture<SessionCommandReply>,
    ) {
        val record = requireRecord(command, future) ?: return
        val runtimeControl = record.control
        if (record.phase != SessionRuntimePhase.RUNNING || runtimeControl == null) {
            future.complete(rejectedReply(command, SessionControlErrorCode.INVALID_STATE, record))
            return
        }
        val generation = record.generation
        val operation = runCatching { runtimeControl.apply(command.control) }.getOrElse {
            future.complete(rejectedReply(command, SessionControlErrorCode.INTERNAL, record))
            return
        }
        operation.whenComplete { _, error ->
            synchronized(lock) {
                if (
                    record.generation != generation ||
                    record.control !== runtimeControl ||
                    record.phase != SessionRuntimePhase.RUNNING
                ) {
                    future.complete(rejectedReply(command, SessionControlErrorCode.GENERATION_CONFLICT, record))
                } else if (error != null) {
                    future.complete(rejectedReply(command, SessionControlErrorCode.INTERNAL, record))
                } else {
                    future.complete(acceptedReply(command, record))
                }
            }
        }
    }

    private fun applyInitialControls(
        control: SessionRuntimeControl,
        initialControls: List<SessionControlOperation>,
    ): CompletableFuture<Unit> = initialControls.fold(CompletableFuture.completedFuture(Unit)) { pending, operation ->
        pending.thenCompose { control.apply(operation) }
    }

    private fun trimOutput(record: RuntimeRecord) {
        while (
            record.outputEvents.size > limits.maxOutputEvents ||
            record.outputBytes > limits.maxOutputBytes
        ) {
            val removed = record.outputEvents.removeFirst()
            record.outputBytes -= removed.bytes
        }
    }

    private fun outputSnapshot(record: RuntimeRecord, afterSequence: Long): SessionOutputSnapshot {
        val first = record.outputEvents.firstOrNull()?.event?.sequence ?: record.nextOutputSequence
        return SessionOutputSnapshot(
            firstAvailableSequence = first,
            nextSequence = record.nextOutputSequence,
            events = record.outputEvents.asSequence()
                .map(OutputRecord::event)
                .filter { event -> event.sequence > afterSequence }
                .toList(),
        )
    }

    private fun requireRecord(
        command: SessionCommandV2,
        future: CompletableFuture<SessionCommandReply>,
    ): RuntimeRecord? {
        val record = runtimes[command.runtimeId]
        if (record == null) {
            future.complete(rejectedReply(command, SessionControlErrorCode.NOT_FOUND))
            return null
        }
        if (command.expectedGeneration != null && command.expectedGeneration != record.generation) {
            future.complete(rejectedReply(command, SessionControlErrorCode.GENERATION_CONFLICT, record))
            return null
        }
        return record
    }

    private fun acceptedReply(
        command: SessionCommandV2,
        record: RuntimeRecord,
        output: SessionOutputSnapshot? = null,
    ): SessionCommandReply = SessionCommandReply(
        ack = SessionCommandAck(
            runtimeId = command.runtimeId,
            commandId = command.commandId,
            command = command.kind,
            generation = record.generation,
            accepted = true,
        ),
        state = snapshot(record),
        result = record.result,
        output = output,
    )

    private fun rejectedReply(
        command: SessionCommandV2,
        error: SessionControlErrorCode,
        record: RuntimeRecord? = runtimes[command.runtimeId],
    ): SessionCommandReply = SessionCommandReply(
        ack = SessionCommandAck(
            runtimeId = command.runtimeId,
            commandId = command.commandId,
            command = command.kind,
            generation = record?.generation ?: 0,
            accepted = false,
            errorCode = error,
        ),
        state = record?.let(::snapshot),
        result = record?.result,
    )

    private fun snapshot(record: RuntimeRecord): SessionRuntimeSnapshot {
        val firstOutput = record.outputEvents.firstOrNull()?.event?.sequence ?: record.nextOutputSequence
        return SessionRuntimeSnapshot(
            runtimeId = record.runtimeId,
            generation = record.generation,
            phase = record.phase,
            isolation = record.spec.isolation,
            firstAvailableOutputSequence = firstOutput,
            nextOutputSequence = record.nextOutputSequence,
        )
    }

    private fun publishState(record: RuntimeRecord) {
        runCatching { eventSink.onState(snapshot(record)) }
    }

    private fun publishOutput(event: SessionOutputEvent) {
        runCatching { eventSink.onOutput(event) }
    }

    private fun publishResult(result: SessionExecutionResult) {
        runCatching { eventSink.onResult(result) }
    }

    private fun completePendingGenerationCommand(
        record: RuntimeRecord,
        command: SessionCommandV2,
        future: CompletableFuture<SessionCommandReply>,
        generation: Long,
    ) {
        val pending = record.pendingGenerationCommand
        if (
            pending?.command == command &&
            pending.future === future &&
            pending.generation == generation
        ) {
            settlePendingGenerationCommand(record)
        }
    }

    private fun settlePendingGenerationCommand(record: RuntimeRecord) {
        val pending = record.pendingGenerationCommand ?: return
        record.pendingGenerationCommand = null
        pending.future.complete(acceptedReply(pending.command, record))
    }

    private inner class SupervisorProcessHost(
        private val record: RuntimeRecord,
        private val generation: Long,
    ) : RuntimeProcessHost {
        override val configuration = RuntimeProcessConfiguration(
            argv = record.spec.argv,
            env = record.spec.env,
        )

        override fun write(stream: RuntimeOutputStream, chunk: String) {
            onProcessOutput(
                record,
                this,
                generation,
                if (stream == RuntimeOutputStream.STDERR) SessionOutputStream.STDERR else SessionOutputStream.STDOUT,
                chunk,
            )
        }

        override fun networkDiagnostic(eventJson: String) {
            onProcessOutput(record, this, generation, SessionOutputStream.NETWORK, eventJson)
        }

        override fun exit(code: Int) {
            onProcessExit(record, this, generation, code)
        }
    }

    private data class CommandExecution(
        val command: SessionCommandV2,
        val future: CompletableFuture<SessionCommandReply>,
    )

    private data class OutputRecord(
        val event: SessionOutputEvent,
        val bytes: Int,
    )

    private data class PendingGenerationCommand(
        val command: SessionCommandV2,
        val future: CompletableFuture<SessionCommandReply>,
        val generation: Long,
    )

    private data class EngineSetup(
        val engine: RuntimeEngine,
        val control: SessionRuntimeControl,
        val entry: ai.oneworks.holonomy.host.RuntimeModuleSource,
        val processHost: RuntimeProcessHost,
    )

    private class RuntimeRecord(
        val runtimeId: RuntimeId,
        val spec: SessionRuntimeSpec,
    ) {
        var generation = 0L
        var nativeHostGeneration = 0L
        var phase = SessionRuntimePhase.CREATED
        var engine: RuntimeEngine? = null
        var control: SessionRuntimeControl? = null
        var currentProcessHost: RuntimeProcessHost? = null
        var pendingGenerationCommand: PendingGenerationCommand? = null
        var result: SessionExecutionResult? = null
        var nextOutputSequence = 1L
        var outputBytes = 0L
        val outputEvents = ArrayDeque<OutputRecord>()
    }

    private companion object {
        private const val CANCEL_EXIT_CODE = 124
        private const val STOP_EXIT_CODE = 143
        private val ACTIVE_PHASES = setOf(
            SessionRuntimePhase.STARTING,
            SessionRuntimePhase.RESTARTING,
            SessionRuntimePhase.RUNNING,
        )
        private val STARTING_PHASES = setOf(
            SessionRuntimePhase.STARTING,
            SessionRuntimePhase.RESTARTING,
        )
        private val TERMINAL_PHASES = setOf(
            SessionRuntimePhase.CANCELED,
            SessionRuntimePhase.STOPPED,
            SessionRuntimePhase.COMPLETED,
            SessionRuntimePhase.FAILED,
            SessionRuntimePhase.DISPOSING,
            SessionRuntimePhase.DISPOSED,
        )

        private fun completedReply(reply: SessionCommandReply): CompletableFuture<SessionCommandReply> =
            CompletableFuture.completedFuture(reply)

        private fun currentProcessId(): Long {
            val android = runCatching {
                val process = Class.forName("android.os.Process")
                (process.getMethod("myPid").invoke(null) as Number).toLong()
            }.getOrNull()
            if (android != null && android > 0) return android
            return runCatching {
                val managementFactory = Class.forName("java.lang.management.ManagementFactory")
                val bean = managementFactory.getMethod("getRuntimeMXBean").invoke(null)
                val name = bean.javaClass.getMethod("getName").invoke(bean) as String
                name.substringBefore('@').toLong()
            }.getOrElse { 1L }
        }
    }

    private fun generationPrincipal(runtimeId: RuntimeId, generation: Long): String =
        "holonomy:$processId:${runtimeId.value}:$generation"
}
