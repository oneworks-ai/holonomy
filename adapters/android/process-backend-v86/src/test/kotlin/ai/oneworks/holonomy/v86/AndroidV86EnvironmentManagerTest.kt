package ai.oneworks.holonomy.v86

import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidV86EnvironmentManagerTest {
    @Test
    fun `runtime scope cannot share a v86 environment across roots`() {
        val backends = mutableListOf<FakeBackend>()
        val transport = ClosingTransport()
        val manager = manager("processTree", backends, transport)

        manager.start(host()).get()
        assertTrue(runCatching { manager.acquire("runtime", "process-1") }.exceptionOrNull() is IllegalStateException)
        assertTrue(backends.isEmpty())

        manager.close()
        manager.close()
        assertEquals(1, transport.closeCount.get())
        assertTrue(runCatching { manager("runtime", backends) }.exceptionOrNull() is IllegalArgumentException)
    }

    @Test
    fun `processTree scope owns and fences one environment per root resource`() {
        val backends = mutableListOf<FakeBackend>()
        val manager = manager("processTree", backends)

        manager.start(host()).get()
        assertTrue(backends.isEmpty())
        val first = manager.acquire("processTree", "process-1")
        val second = manager.acquire("processTree", "process-2")

        assertEquals(2, backends.size)
        assertTrue(first.environmentId != second.environmentId)
        assertEquals(setOf(first.environmentId, second.environmentId), manager.activeEnvironmentIds())

        first.close()
        first.close()
        assertEquals(1, backends.first().closeCount.get())
        assertEquals(setOf(second.environmentId), manager.activeEnvironmentIds())
        assertEquals(0, backends.last().closeCount.get())

        manager.close()
        assertEquals(1, backends.last().closeCount.get())
    }

    @Test
    fun `close fences an environment acquisition waiting for readiness`() {
        val backend = DelayedBackend()
        val manager = AndroidV86EnvironmentManager(
            processId = "runtime-process",
            generation = 7,
            defaultScope = "processTree",
            startupTimeoutMs = 1_000,
            eventSink = AndroidV86ProcessEventSink {},
            networkTransport = null,
        ) { _, _, _ -> backend }
        manager.start(host()).get()
        val lease = manager.acquire("processTree", "process-1")
        assertTrue(backend.started.await(1, TimeUnit.SECONDS))
        assertTrue(!lease.readiness.isDone)
        manager.close()
        backend.readiness.complete(Unit)

        assertTrue(lease.readiness.isCompletedExceptionally)
        assertEquals(emptySet<String>(), manager.activeEnvironmentIds())
        assertEquals(1, backend.closeCount.get())
    }

    @Test
    fun `known ready lease cannot submit after manager close or release`() {
        val backends = mutableListOf<FakeBackend>()
        val manager = manager("processTree", backends)
        manager.start(host()).get()
        val lease = manager.acquire("processTree", "process-1")
        assertTrue(lease.readiness.isDone)
        manager.close()
        assertTrue(runCatching { lease.submit(org.json.JSONObject()) }.isFailure)
        lease.close()
        assertEquals(1, backends.single().closeCount.get())
    }

    private fun manager(
        defaultScope: String,
        backends: MutableList<FakeBackend>,
        transport: AndroidV86NetworkTransport? = null,
    ) = AndroidV86EnvironmentManager(
        processId = "runtime-process",
        generation = 7,
        defaultScope = defaultScope,
        startupTimeoutMs = 1_000,
        eventSink = AndroidV86ProcessEventSink {},
        networkTransport = transport,
    ) { environmentId, scope, _ ->
        FakeBackend(environmentId, scope).also(backends::add)
    }

    private fun host() = RuntimeTrustedBackendHost { _, _, _ -> }

    private class FakeBackend(
        val environmentId: String,
        val scope: String,
    ) : AndroidV86EnvironmentBackend {
        val closeCount = AtomicInteger()

        override fun start(host: RuntimeTrustedBackendHost) = CompletableFuture.completedFuture(Unit)

        override fun submit(command: org.json.JSONObject) = Unit

        override fun close() {
            closeCount.incrementAndGet()
        }
    }

    private class DelayedBackend : AndroidV86EnvironmentBackend {
        val closeCount = AtomicInteger()
        val readiness = CompletableFuture<Unit>()
        val started = CountDownLatch(1)

        override fun start(host: RuntimeTrustedBackendHost): CompletableFuture<Unit> {
            started.countDown()
            return readiness
        }

        override fun submit(command: org.json.JSONObject) = Unit

        override fun close() {
            closeCount.incrementAndGet()
        }
    }

    private class ClosingTransport : AndroidV86NetworkTransport {
        val closeCount = AtomicInteger()

        override fun execute(request: org.json.JSONObject, authorizationTerminal: org.json.JSONObject) =
            AndroidV86NetworkTransport.success()

        override fun close() {
            closeCount.incrementAndGet()
        }
    }
}
