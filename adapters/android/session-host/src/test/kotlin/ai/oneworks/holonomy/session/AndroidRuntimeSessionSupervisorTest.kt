package ai.oneworks.holonomy.session

import ai.oneworks.holonomy.host.RuntimeCapabilities
import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.host.RuntimeEvaluation
import ai.oneworks.holonomy.host.RuntimeImplementationStage
import ai.oneworks.holonomy.host.RuntimeMicrotaskMode
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import ai.oneworks.holonomy.host.RuntimeOutputStream
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidRuntimeSessionSupervisorTest {
    @Test
    fun `late reply preserves current output state and result across generations`() {
        withStoredSupervisor { f ->
            f.start()
            f.output("old")
            f.engine.context.processHost.exit(0)
            f.codec.beforeReply = {
                f.restart("restart")
                f.output("new-a")
                f.output("new-b")
                f.engine.context.processHost.exit(7)
            }
            val reply = f.status("captured")
            assertEquals(1L, reply.result?.generation)
            assertEquals(2L, f.store.readState(f.id)?.generation)
            assertEquals(2L, f.store.readResult(f.id)?.generation)
            assertEquals(7, f.store.readResult(f.id)?.exitCode)
            val output = f.store.readOutput(f.id)!!
            assertEquals(2L, output.firstAvailableSequence)
            assertEquals(4L, output.nextSequence)
            assertEquals(listOf("new-a", "new-b"), output.events.map { it.chunk })
            assertEquals(reply, f.store.readReply(reply.ack.commandId))
            f.restart("continue")
            f.output("continued")
            assertEquals(listOf(3L, 4L), f.store.readOutput(f.id)?.events?.map { it.sequence })
        }
    }

    @Test
    fun `late status preserves same generation output and terminal state`() {
        withStoredSupervisor { f ->
            f.start()
            f.output("one")
            f.codec.beforeReply = {
                f.output("two")
                f.engine.context.processHost.exit(0)
            }
            val reply = f.status("captured")
            assertEquals(SessionRuntimePhase.RUNNING, reply.state?.phase)
            assertEquals(2L, reply.output?.nextSequence)
            assertEquals(SessionRuntimePhase.COMPLETED, f.store.readState(f.id)?.phase)
            assertEquals(3L, f.store.readOutput(f.id)?.nextSequence)
            assertEquals(0, f.store.readResult(f.id)?.exitCode)
        }
    }

    @Test
    fun `event owned handler has empty status replies and durable lifecycle events`() {
        withStoredSupervisor { f ->
            assertEquals(SessionRuntimePhase.CREATED, f.store.readState(f.id)?.phase)
            val empty = f.status("empty")
            assertEquals(1L, empty.output?.nextSequence)
            assertTrue(empty.output!!.events.isEmpty())
            val publicCodec = JsonSessionControlCodec()
            assertEquals(empty, publicCodec.decodeReply(publicCodec.encodeReply(empty)))
            assertEquals(null, f.store.readOutput(f.id))
            f.start()
            assertEquals(SessionRuntimePhase.RUNNING, f.store.readState(f.id)?.phase)
            f.handle(StopRuntimeCommand(f.id, CommandId("stop")))
            assertEquals(SessionRuntimePhase.STOPPED, f.store.readState(f.id)?.phase)
            assertEquals(143, f.store.readResult(f.id)?.exitCode)
            f.restart("restart")
            assertEquals(2L, f.store.readState(f.id)?.generation)
            f.handle(CancelRuntimeCommand(f.id, CommandId("cancel")))
            assertEquals(SessionRuntimePhase.CANCELED, f.store.readState(f.id)?.phase)
            assertEquals(124, f.store.readResult(f.id)?.exitCode)
            f.handle(DisposeRuntimeCommand(f.id, CommandId("dispose")))
            assertEquals(SessionRuntimePhase.DISPOSED, f.store.readState(f.id)?.phase)
        }
    }

    @Test
    fun `same generation output continues after late reply and replay without status repair`() {
        withStoredSupervisor { f ->
            f.start()
            f.output("one")
            f.codec.beforeReply = { f.output("two") }
            val captured = f.status("captured")
            assertEquals(2L, captured.output?.nextSequence)
            assertEquals(3L, f.store.readOutput(f.id)?.nextSequence)
            // Durable state is the last lifecycle event, not a per-output checkpoint.
            assertEquals(1L, f.store.readState(f.id)?.nextOutputSequence)
            f.output("three")
            assertEquals(listOf(2L, 3L), f.store.readOutput(f.id)?.events?.map { it.sequence })
            assertEquals(captured, f.status("captured"))
            assertEquals(4L, f.store.readOutput(f.id)?.nextSequence)
            assertEquals(4L, f.status("fresh").output?.nextSequence)
            assertEquals(1L, f.store.readState(f.id)?.nextOutputSequence)
        }
    }

    @Test
    fun `failed start and supervisor close are persisted by the event owner`() {
        val failedStart = CompletableFuture<Unit>()
        failedStart.completeExceptionally(IllegalStateException("engine boundary failure"))
        withStoredSupervisor(startGate = failedStart) { f ->
            val reply = f.start()
            assertEquals(SessionRuntimePhase.FAILED, reply.state?.phase)
            assertEquals(reply.state, f.store.readState(f.id))
            assertEquals(reply.result, f.store.readResult(f.id))
            f.supervisor.close()
            assertEquals(SessionRuntimePhase.DISPOSED, f.store.readState(f.id)?.phase)
        }
    }

    @Test
    fun `legacy two argument handler still mirrors captured snapshots`() {
        withStoredSupervisor(legacy = true) { f ->
            f.start()
            f.output("one")
            f.codec.beforeReply = {
                f.output("two")
                f.engine.context.processHost.exit(0)
            }
            val reply = f.status("captured")
            assertEquals(reply.state, f.store.readState(f.id))
            assertEquals(reply.output, f.store.readOutput(f.id))
        }
    }

    @Test
    fun `concurrent output producers publish in sequence allocation order`() {
        val firstEntered = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val secondEntered = CountDownLatch(1)
        withStoredSupervisor(wrapSink = { stored ->
            object : SessionSupervisorEventSink by stored {
                override fun onOutput(event: SessionOutputEvent) {
                    if (event.sequence == 1L) {
                        firstEntered.countDown()
                        check(releaseFirst.await(2, TimeUnit.SECONDS))
                    } else secondEntered.countDown()
                    stored.onOutput(event)
                }
            }
        }) { f ->
            f.start()
            val first = Thread { f.output("stdout") }
            val second = Thread { f.engine.context.processHost.networkDiagnostic("network") }
            first.start()
            assertTrue(firstEntered.await(2, TimeUnit.SECONDS))
            second.start()
            try {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                while (second.state != Thread.State.BLOCKED && secondEntered.count != 0L && System.nanoTime() < deadline) Thread.yield()
                assertTrue(second.state == Thread.State.BLOCKED || secondEntered.count == 0L)
            } finally {
                releaseFirst.countDown()
                first.join(2000)
                second.join(2000)
            }
            assertFalse(first.isAlive)
            assertFalse(second.isAlive)
            assertEquals(listOf(1L, 2L), f.store.readOutput(f.id)?.events?.map { it.sequence })
            assertEquals(3L, f.store.readOutput(f.id)?.nextSequence)
        }
    }

    @Test
    fun `isolated process is schema valid but stably unsupported`() {
        val fixture = SupervisorFixture()
        val command = testCreateCommand("runtime", "create", isolation = SessionIsolation.ISOLATED_PROCESS)

        val reply = fixture.supervisor.execute(command).await()

        assertFalse(reply.ack.accepted)
        assertEquals(SessionControlErrorCode.ISOLATION_UNSUPPORTED, reply.ack.errorCode)
        assertTrue(fixture.supervisor.snapshots().isEmpty())
    }

    @Test
    fun `sandboxed filesystem is schema valid but rejected before runtime creation`() {
        val fixture = SupervisorFixture()
        val command = testCreateCommand(
            "runtime",
            "create",
            sandboxPolicy = SessionSandboxPolicy(
                filesystem = SessionSandboxFilesystemPolicy(SessionSandboxFilesystemAccess.SANDBOXED),
            ),
        )

        val reply = fixture.supervisor.execute(command).await()

        assertEquals(SessionControlErrorCode.SANDBOX_CAPABILITY_UNSUPPORTED, reply.ack.errorCode)
        assertTrue(fixture.runtimeFactory.engines.isEmpty())
        assertTrue(fixture.nativeHosts.contexts.isEmpty())
    }

    @Test
    fun `command replay returns the same future and command identity conflicts fail closed`() {
        val fixture = SupervisorFixture()
        val command = testCreateCommand("runtime", "create")

        val first = fixture.supervisor.execute(command)
        val replay = fixture.supervisor.execute(command)
        assertSame(first, replay)
        assertEquals(first.await(), replay.await())

        val collision = fixture.supervisor.execute(
            StatusRuntimeCommand(RuntimeId("other"), CommandId("create")),
        ).await()
        assertEquals(SessionControlErrorCode.COMMAND_CONFLICT, collision.ack.errorCode)
    }

    @Test
    fun `completed command history rolls forward while preserving recent lifecycle replay`() {
        val fixture = SupervisorFixture(limits = SessionSupervisorLimits(maxCommandHistory = 3))
        fixture.create("runtime")
        fixture.start("runtime")

        repeat(12) { index ->
            val status = fixture.status("runtime", "status-$index")
            assertEquals(SessionRuntimePhase.RUNNING, status.state?.phase)
        }

        val stopCommand = StopRuntimeCommand(
            RuntimeId("runtime"),
            CommandId("stop"),
            expectedGeneration = 1,
        )
        val stop = fixture.supervisor.execute(stopCommand)
        assertEquals(SessionRuntimePhase.STOPPED, stop.await().state?.phase)
        assertSame(stop, fixture.supervisor.execute(stopCommand))

        val disposeCommand = DisposeRuntimeCommand(
            RuntimeId("runtime"),
            CommandId("dispose"),
            expectedGeneration = 1,
        )
        val dispose = fixture.supervisor.execute(disposeCommand)
        assertEquals(SessionRuntimePhase.DISPOSED, dispose.await().state?.phase)
        assertSame(dispose, fixture.supervisor.execute(disposeCommand))
    }

    @Test
    fun `start creates a fresh host and executes the canonical entry`() {
        val fixture = SupervisorFixture()
        fixture.create("runtime")

        val reply = fixture.supervisor.execute(
            StartRuntimeCommand(RuntimeId("runtime"), CommandId("start"), expectedGeneration = 0),
        ).await()

        assertEquals(SessionRuntimePhase.RUNNING, reply.state?.phase)
        assertEquals(1, reply.ack.generation)
        assertEquals(1, fixture.runtimeFactory.engines.size)
        assertEquals("app+local://workspace/entry.mjs", fixture.runtimeFactory.engines.single().executed.single().resourceUrl)
        assertEquals(1, fixture.nativeHosts.created.size)
    }

    @Test
    fun `logical runtimes keep independent engines output and results`() {
        val fixture = SupervisorFixture()
        fixture.create("alpha")
        fixture.create("beta")
        fixture.start("alpha")
        fixture.start("beta")
        val alpha = fixture.runtimeFactory.engine("alpha")
        val beta = fixture.runtimeFactory.engine("beta")

        alpha.context.processHost.write(RuntimeOutputStream.STDOUT, "alpha")
        alpha.context.processHost.networkDiagnostic("{\"kind\":\"requestStarted\"}")
        beta.context.processHost.write(RuntimeOutputStream.STDERR, "beta")
        alpha.context.processHost.exit(0)

        val alphaStatus = fixture.status("alpha", "status-alpha")
        val betaStatus = fixture.status("beta", "status-beta")
        assertEquals(SessionRuntimePhase.COMPLETED, alphaStatus.state?.phase)
        assertEquals(0, alphaStatus.result?.exitCode)
        assertEquals(
            listOf("alpha", "{\"kind\":\"requestStarted\"}"),
            alphaStatus.output?.events?.map(SessionOutputEvent::chunk),
        )
        assertEquals(
            listOf(SessionOutputStream.STDOUT, SessionOutputStream.NETWORK),
            alphaStatus.output?.events?.map(SessionOutputEvent::stream),
        )
        assertEquals(SessionRuntimePhase.RUNNING, betaStatus.state?.phase)
        assertEquals(listOf("beta"), betaStatus.output?.events?.map(SessionOutputEvent::chunk))
    }

    @Test
    fun `expected generation rejects stale process control`() {
        val fixture = SupervisorFixture()
        fixture.create("runtime")
        fixture.start("runtime")

        val stale = fixture.supervisor.execute(
            StopRuntimeCommand(RuntimeId("runtime"), CommandId("stop"), expectedGeneration = 0),
        ).await()

        assertEquals(SessionControlErrorCode.GENERATION_CONFLICT, stale.ack.errorCode)
        assertEquals(SessionRuntimePhase.RUNNING, stale.state?.phase)
    }

    @Test
    fun `output is sequenced and bounded snapshots expose cursor gaps`() {
        val fixture = SupervisorFixture(
            limits = SessionSupervisorLimits(maxOutputEvents = 2, maxOutputBytes = 64),
        )
        fixture.create("runtime")
        fixture.start("runtime")
        val host = fixture.runtimeFactory.engine("runtime").context.processHost

        host.write(RuntimeOutputStream.STDOUT, "one")
        host.write(RuntimeOutputStream.STDOUT, "two")
        host.write(RuntimeOutputStream.STDOUT, "three")

        val all = fixture.status("runtime", "status-all", after = 0).output!!
        assertEquals(2, all.firstAvailableSequence)
        assertEquals(4, all.nextSequence)
        assertEquals(listOf(2L, 3L), all.events.map(SessionOutputEvent::sequence))
        val tail = fixture.status("runtime", "status-tail", after = 2).output!!
        assertEquals(listOf("three"), tail.events.map(SessionOutputEvent::chunk))
    }

    @Test
    fun `restart fences late output and exit while creating a new generation`() {
        val fixture = SupervisorFixture()
        fixture.create("runtime")
        fixture.start("runtime")
        val oldEngine = fixture.runtimeFactory.engine("runtime")
        val oldHost = oldEngine.context.processHost

        val restart = fixture.supervisor.execute(
            RestartRuntimeCommand(RuntimeId("runtime"), CommandId("restart"), expectedGeneration = 1),
        ).await()
        oldHost.write(RuntimeOutputStream.STDOUT, "late")
        oldHost.exit(9)
        val current = fixture.runtimeFactory.engine("runtime")
        current.context.processHost.write(RuntimeOutputStream.STDOUT, "current")

        assertEquals(2, restart.ack.generation)
        assertEquals(SessionRuntimePhase.RUNNING, restart.state?.phase)
        assertTrue(oldEngine.disposed)
        assertEquals(2, fixture.nativeHosts.created.size)
        val status = fixture.status("runtime", "status")
        assertEquals(SessionRuntimePhase.RUNNING, status.state?.phase)
        assertEquals(listOf("current"), status.output?.events?.map(SessionOutputEvent::chunk))
    }

    @Test
    fun `restart preserves immutable policy and derives a fresh generation principal`() {
        val policy = SessionSandboxPolicy(
            network = SessionSandboxNetworkPolicy(
                access = SessionSandboxNetworkAccess.RESTRICTED,
                allowedOrigins = setOf("https://api.example"),
                allowedSchemes = setOf("https"),
            ),
        )
        val fixture = SupervisorFixture()
        fixture.supervisor.execute(testCreateCommand("runtime", "create", sandboxPolicy = policy)).await()
        fixture.start("runtime")
        fixture.supervisor.execute(
            RestartRuntimeCommand(RuntimeId("runtime"), CommandId("restart"), expectedGeneration = 1),
        ).await()

        assertEquals(2, fixture.nativeHosts.contexts.size)
        val first = fixture.nativeHosts.contexts[0]
        val second = fixture.nativeHosts.contexts[1]
        assertEquals(policy, first.sandboxPolicy)
        assertSame(first.sandboxPolicy, second.sandboxPolicy)
        assertEquals(policy.digest, first.sandboxPolicyDigest)
        assertEquals(policy.digest, second.sandboxPolicyDigest)
        assertEquals(1, first.runtimeGeneration)
        assertEquals(2, second.runtimeGeneration)
        assertTrue(first.principal.endsWith(":runtime:1"))
        assertTrue(second.principal.endsWith(":runtime:2"))
        assertFalse(first.principal == second.principal)
        assertEquals(first.principal, fixture.runtimeFactory.engines[0].context.principal)
        assertEquals(second.principal, fixture.runtimeFactory.engines[1].context.principal)
    }

    @Test
    fun `native host identity reuse fails the new generation`() {
        val shared = RecordingNativeHost()
        val fixture = SupervisorFixture(nativeHostFactory = SessionNativeHostFactory { shared })
        fixture.create("runtime")
        fixture.start("runtime")

        val restart = fixture.supervisor.execute(
            RestartRuntimeCommand(RuntimeId("runtime"), CommandId("restart")),
        ).await()

        assertEquals(SessionRuntimePhase.FAILED, restart.state?.phase)
        assertEquals(1, restart.result?.exitCode)
    }

    @Test
    fun `cancel stop and dispose publish stable terminal state`() {
        val fixture = SupervisorFixture()
        fixture.create("cancelled")
        fixture.start("cancelled")
        val cancel = fixture.supervisor.execute(
            CancelRuntimeCommand(RuntimeId("cancelled"), CommandId("cancel")),
        ).await()
        assertEquals(SessionRuntimePhase.CANCELED, cancel.state?.phase)
        assertEquals(124, cancel.result?.exitCode)

        fixture.create("stopped")
        fixture.start("stopped")
        val stop = fixture.supervisor.execute(
            StopRuntimeCommand(RuntimeId("stopped"), CommandId("stop")),
        ).await()
        assertEquals(SessionRuntimePhase.STOPPED, stop.state?.phase)
        assertEquals(143, stop.result?.exitCode)

        val disposeCommand = DisposeRuntimeCommand(RuntimeId("stopped"), CommandId("dispose"))
        val dispose = fixture.supervisor.execute(disposeCommand)
        assertSame(dispose, fixture.supervisor.execute(disposeCommand))
        val disposed = dispose.await()
        assertEquals(SessionRuntimePhase.DISPOSED, disposed.state?.phase)
        assertEquals(1, disposed.ack.generation)
        assertEquals(1L, disposed.result?.generation)
    }

    @Test
    fun `oversized output fails only its current logical runtime`() {
        val fixture = SupervisorFixture(
            limits = SessionSupervisorLimits(maxOutputChunkBytes = 4),
        )
        fixture.create("failed")
        fixture.create("healthy")
        fixture.start("failed")
        fixture.start("healthy")

        fixture.runtimeFactory.engine("failed").context.processHost.write(RuntimeOutputStream.STDOUT, "12345")

        assertEquals(SessionRuntimePhase.FAILED, fixture.status("failed", "failed-status").state?.phase)
        assertEquals(SessionRuntimePhase.RUNNING, fixture.status("healthy", "healthy-status").state?.phase)
    }

    @Test
    fun `stop settles an in-flight start and fences its late completion`() {
        val startGate = CompletableFuture<Unit>()
        val runtimeFactory = RecordingRuntimeFactory(startGate)
        val fixture = SupervisorFixture(runtimeFactory = runtimeFactory)
        fixture.create("runtime")
        val start = fixture.supervisor.execute(
            StartRuntimeCommand(RuntimeId("runtime"), CommandId("start")),
        )
        assertFalse(start.isDone)

        val stopped = fixture.supervisor.execute(
            StopRuntimeCommand(RuntimeId("runtime"), CommandId("stop"), expectedGeneration = 1),
        ).await()
        assertTrue(start.isDone)
        assertEquals(SessionRuntimePhase.STOPPED, stopped.state?.phase)

        startGate.complete(Unit)
        assertEquals(SessionRuntimePhase.STOPPED, fixture.status("runtime", "status-after-late-start").state?.phase)
    }

    @Test
    fun `typed controller delegates lifecycle commands without hiding caller command ids`() {
        val fixture = SupervisorFixture()
        val controller = AndroidRuntimeSessionController(fixture.supervisor)
        val created = controller.create(testCreateCommand("runtime", "create")).await()
        val started = controller.start(
            StartRuntimeCommand(RuntimeId("runtime"), CommandId("start"), expectedGeneration = 0),
        ).await()
        val status = controller.status(
            StatusRuntimeCommand(RuntimeId("runtime"), CommandId("status"), expectedGeneration = 1),
        ).await()

        assertEquals(CommandId("create"), created.ack.commandId)
        assertEquals(CommandId("start"), started.ack.commandId)
        assertEquals(CommandId("status"), status.ack.commandId)
        assertEquals(SessionRuntimePhase.RUNNING, status.state?.phase)
    }

    @Test
    fun `initial and live controls use the trusted runtime control seam in order`() {
        val fixture = SupervisorFixture()
        val create = testCreateCommand(
            runtimeId = "runtime",
            commandId = "create",
            initialControls = listOf(
                SessionControlOperation("network.updateRules", "{\"mode\":\"deny\"}"),
            ),
        )
        fixture.supervisor.execute(create).await()
        fixture.start("runtime")
        val engine = fixture.runtimeFactory.engine("runtime")

        assertEquals(
            listOf("start", "control:network.updateRules", "entry"),
            engine.events,
        )
        val live = fixture.supervisor.execute(
            ControlRuntimeCommand(
                runtimeId = RuntimeId("runtime"),
                commandId = CommandId("control"),
                expectedGeneration = 1,
                control = SessionControlOperation("network.updateRules", "{\"mode\":\"allow\"}"),
            ),
        ).await()
        assertTrue(live.ack.accepted)
        assertEquals(2, engine.control.applied.size)

        val stale = fixture.supervisor.execute(
            ControlRuntimeCommand(
                runtimeId = RuntimeId("runtime"),
                commandId = CommandId("stale-control"),
                expectedGeneration = 2,
                control = SessionControlOperation("network.updateRules", "{}"),
            ),
        ).await()
        assertEquals(SessionControlErrorCode.GENERATION_CONFLICT, stale.ack.errorCode)
        assertEquals(2, engine.control.applied.size)
    }
}

private class SupervisorFixture(
    val runtimeFactory: RecordingRuntimeFactory = RecordingRuntimeFactory(),
    nativeHostFactory: SessionNativeHostFactory? = null,
    limits: SessionSupervisorLimits = SessionSupervisorLimits(),
) {
    val nativeHosts = RecordingNativeHostFactory()
    val supervisor = AndroidRuntimeSessionSupervisor(
        runtimeFactory = runtimeFactory,
        nativeHostFactory = nativeHostFactory ?: nativeHosts,
        limits = limits,
    )

    fun create(runtimeId: String) {
        val reply = supervisor.execute(testCreateCommand(runtimeId, "create-$runtimeId")).await()
        assertTrue(reply.ack.accepted)
    }

    fun start(runtimeId: String) {
        val reply = supervisor.execute(
            StartRuntimeCommand(RuntimeId(runtimeId), CommandId("start-$runtimeId")),
        ).await()
        assertTrue(reply.ack.accepted)
    }

    fun status(runtimeId: String, commandId: String, after: Long = 0): SessionCommandReply =
        supervisor.execute(
            StatusRuntimeCommand(RuntimeId(runtimeId), CommandId(commandId), afterOutputSequence = after),
        ).await()
}

internal fun testCreateCommand(
    runtimeId: String,
    commandId: String,
    isolation: SessionIsolation = SessionIsolation.LOGICAL_RUNTIME,
    initialControls: List<SessionControlOperation> = emptyList(),
    sandboxPolicy: SessionSandboxPolicy = SessionSandboxPolicy(),
): CreateRuntimeCommand = CreateRuntimeCommand(
    runtimeId = RuntimeId(runtimeId),
    commandId = CommandId(commandId),
    spec = SessionRuntimeSpec(
        entryUrl = "app+local://workspace/entry.mjs",
        modules = listOf(
            SessionModuleSpec("app+local://workspace/entry.mjs", "export const value = 1"),
        ),
        isolation = isolation,
        initialControls = initialControls,
        sandboxPolicy = sandboxPolicy,
    ),
)

private fun <T> CompletableFuture<T>.await(): T = get(2, TimeUnit.SECONDS)

private class RecordingRuntimeFactory(
    private val startGate: CompletableFuture<Unit>? = null,
) : SessionRuntimeFactory {
    val engines = mutableListOf<RecordingRuntimeEngine>()

    override fun create(context: SessionRuntimeContext): SessionRuntimeInstance {
        val engine = RecordingRuntimeEngine(context, startGate).also(engines::add)
        return SessionRuntimeInstance(engine, engine.control)
    }

    fun engine(runtimeId: String): RecordingRuntimeEngine =
        engines.last { engine -> engine.context.runtimeId == RuntimeId(runtimeId) }
}

private class RecordingRuntimeEngine(
    val context: SessionRuntimeContext,
    private val startGate: CompletableFuture<Unit>? = null,
) : RuntimeEngine {
    override val capabilities = RuntimeCapabilities(
        implementationStage = RuntimeImplementationStage.BOOTSTRAP,
        microtaskMode = RuntimeMicrotaskMode.AUTO,
        esmModules = true,
        inspectorEnabled = false,
    )
    val executed = mutableListOf<RuntimeModuleSource>()
    val events = mutableListOf<String>()
    val control = RecordingRuntimeControl(events)
    var disposed = false
        private set
    private var nativeHost: RuntimeNativeHost? = null

    override fun start(): CompletableFuture<Unit> = runCatching {
        nativeHost = context.freshNativeHostFactory()
        events += "start"
    }.fold(
        onSuccess = { startGate ?: CompletableFuture.completedFuture(Unit) },
        onFailure = { error -> CompletableFuture<Unit>().also { it.completeExceptionally(error) } },
    )

    override fun evaluate(source: String): CompletableFuture<RuntimeEvaluation> =
        CompletableFuture.completedFuture(RuntimeEvaluation(RuntimeEvaluation.Kind.UNDEFINED))

    override fun executeModule(module: RuntimeModuleSource): CompletableFuture<Unit> {
        executed += module
        events += "entry"
        return CompletableFuture.completedFuture(Unit)
    }

    override fun terminate(): CompletableFuture<Unit> = dispose()

    override fun dispose(): CompletableFuture<Unit> {
        disposed = true
        nativeHost?.close()
        nativeHost = null
        return CompletableFuture.completedFuture(Unit)
    }
}

private class RecordingRuntimeControl(
    private val events: MutableList<String>,
) : SessionRuntimeControl {
    val applied = mutableListOf<SessionControlOperation>()

    override fun apply(control: SessionControlOperation): CompletableFuture<Unit> {
        applied += control
        events += "control:${control.operation}"
        return CompletableFuture.completedFuture(Unit)
    }
}

private class RecordingNativeHostFactory : SessionNativeHostFactory {
    val created = mutableListOf<RecordingNativeHost>()
    val contexts = mutableListOf<SessionNativeHostContext>()

    override fun create(context: SessionNativeHostContext): RuntimeNativeHost = RecordingNativeHost().also {
        contexts += context
        created += it
    }
}

private class RecordingNativeHost : RuntimeNativeHost {
    val closeCount = AtomicInteger()

    override fun dispatch(
        requestId: String,
        requestJson: String,
        contextJson: String,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
        resourceSink: RuntimeNativeResourceEventSink,
    ) = Unit

    override fun close() {
        closeCount.incrementAndGet()
    }
}

private class StoredSupervisorFixture(
    directory: java.io.File,
    legacy: Boolean,
    startGate: CompletableFuture<Unit>?,
    wrapSink: (StoredSessionSupervisorEventSink) -> SessionSupervisorEventSink,
) : AutoCloseable {
    val id = RuntimeId("runtime")
    val codec = ReplyHookCodec()
    val store = AppPrivateSessionCommandStore(directory, codec)
    private val factory = RecordingRuntimeFactory(startGate)
    val supervisor = AndroidRuntimeSessionSupervisor(
        factory, RecordingNativeHostFactory(),
        wrapSink(StoredSessionSupervisorEventSink(store, StoredSessionOutputLimits(maxEvents = 2, maxBytes = 64))),
    )
    // Match the concrete Service factory; keep the legacy constructor independently covered.
    private val handler = if (legacy) StoredSessionCommandHandler(supervisor, store)
        else StoredSessionCommandHandler.withEventOwnedSnapshots(supervisor, store)
    val engine get() = factory.engines.last()
    init { handle(testCreateCommand("runtime", "create")) }
    fun handle(command: SessionCommandV2) = handler.handle(command).await()
    fun start() = handle(StartRuntimeCommand(id, CommandId("start")))
    fun restart(command: String) = handle(RestartRuntimeCommand(id, CommandId(command)))
    fun output(chunk: String) = engine.context.processHost.write(RuntimeOutputStream.STDOUT, chunk)
    fun status(command: String) = handle(StatusRuntimeCommand(id, CommandId(command)))
    override fun close() = supervisor.close()
}

private fun withStoredSupervisor(
    legacy: Boolean = false,
    startGate: CompletableFuture<Unit>? = null,
    wrapSink: (StoredSessionSupervisorEventSink) -> SessionSupervisorEventSink = { it },
    action: (StoredSupervisorFixture) -> Unit,
) {
    val directory = Files.createTempDirectory("holonomy-stored-supervisor").toFile()
    try { StoredSupervisorFixture(directory, legacy, startGate, wrapSink).use(action) }
    finally { directory.deleteRecursively() }
}

private class ReplyHookCodec : SessionControlCodec {
    private val values = ConcurrentHashMap<String, Any>()
    private val sequence = AtomicInteger()
    var beforeReply: (() -> Unit)? = null
    private fun encode(value: Any): ByteArray {
        val key = "value-${sequence.incrementAndGet()}"
        values[key] = value
        return key.toByteArray()
    }
    @Suppress("UNCHECKED_CAST")
    private fun <T> decode(bytes: ByteArray): T = values.getValue(bytes.toString(Charsets.UTF_8)) as T
    override fun encodeCommand(command: SessionCommandV2) = encode(command)
    override fun decodeCommand(bytes: ByteArray): SessionCommandV2 = decode(bytes)
    override fun encodeReply(reply: SessionCommandReply): ByteArray {
        val hook = beforeReply
        beforeReply = null
        hook?.invoke()
        return encode(reply)
    }
    override fun decodeReply(bytes: ByteArray): SessionCommandReply = decode(bytes)
    override fun encodeState(state: SessionRuntimeSnapshot) = encode(state)
    override fun decodeState(bytes: ByteArray): SessionRuntimeSnapshot = decode(bytes)
    override fun encodeResult(result: SessionExecutionResult) = encode(result)
    override fun decodeResult(bytes: ByteArray): SessionExecutionResult = decode(bytes)
    override fun encodeOutput(output: SessionOutputSnapshot) = encode(output)
    override fun decodeOutput(bytes: ByteArray): SessionOutputSnapshot = decode(bytes)
}
