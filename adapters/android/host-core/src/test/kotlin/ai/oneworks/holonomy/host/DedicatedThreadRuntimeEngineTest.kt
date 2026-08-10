package ai.oneworks.holonomy.host

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DedicatedThreadRuntimeEngineTest {
    @Test
    fun `operations stay on one dedicated thread and disposal is idempotent`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)

        engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertEquals(
            RuntimeEvaluation(RuntimeEvaluation.Kind.NUMBER, "1"),
            engine.evaluate("engine-id").get(TIMEOUT_SECONDS, TimeUnit.SECONDS),
        )
        val firstDispose = engine.dispose()
        assertSame(firstDispose, engine.dispose())
        firstDispose.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

        assertEquals(1, factory.adapters.size)
        assertEquals(1, factory.adapters.single().operationThreadIds.toSet().size)
        assertFalse(factory.adapters.single().operationThreadIds.contains(Thread.currentThread().id))
        assertEquals(1, factory.adapters.single().closeCount.get())
        assertFailsWithCode(RuntimeEngineErrorCode.DISPOSED, engine.evaluate("1 + 1"))
    }

    @Test
    fun `unknown adapter failures are redacted`() {
        val engine = DedicatedThreadRuntimeEngine(FakeAdapterFactory())
        engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

        val error = assertFailsWithCode(RuntimeEngineErrorCode.INTERNAL, engine.evaluate("fail"))
        assertEquals("The runtime engine operation failed", error.message)
        engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    @Test
    fun `wakeups coalesce rearm and stay generation bound`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val first = factory.adapters.single()

        engine.evaluate("schedule-rearm").get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertTrue(first.rearmed.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assertFalse(first.cancelled.await(200, TimeUnit.MILLISECONDS))
        assertEquals(listOf("rearmed"), first.wakeupEvents)
        assertEquals(first.operationThreadIds.first(), first.wakeupThreadIds.single())

        engine.evaluate("schedule-stale").get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.terminate().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertFalse(first.stale.await(200, TimeUnit.MILLISECONDS))
        engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertEquals(2, factory.adapters.size)
        engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    @Test
    fun `fatal callbacks terminate after unwind and disposal cancels races`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

        assertFailsWithCode(RuntimeEngineErrorCode.TERMINATED, engine.evaluate("fatal"))
        engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val recreated = factory.adapters.last()
        engine.evaluate("schedule-stale").get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertFalse(recreated.stale.await(200, TimeUnit.MILLISECONDS))
        assertEquals(2, factory.adapters.size)
    }

    private class FakeAdapterFactory : RuntimeAdapterFactory {
        override val capabilities = RuntimeCapabilities(
            implementationStage = RuntimeImplementationStage.BOOTSTRAP,
            microtaskMode = RuntimeMicrotaskMode.AUTO,
            esmModules = true,
            inspectorEnabled = false,
        )
        val adapters = Collections.synchronizedList(mutableListOf<FakeAdapter>())

        override fun create(
            threadGuard: RuntimeThreadGuard,
            host: RuntimeAdapterHost,
        ): RuntimeAdapter = FakeAdapter(adapters.size + 1, threadGuard, host).also(adapters::add)
    }

    private class FakeAdapter(
        private val id: Int,
        private val threadGuard: RuntimeThreadGuard,
        private val host: RuntimeAdapterHost,
    ) : RuntimeAdapter {
        val cancelled = CountDownLatch(1)
        val operationThreadIds = Collections.synchronizedList(mutableListOf<Long>())
        val closeCount = AtomicInteger(0)
        val rearmed = CountDownLatch(1)
        val stale = CountDownLatch(1)
        val wakeupEvents = Collections.synchronizedList(mutableListOf<String>())
        val wakeupThreadIds = Collections.synchronizedList(mutableListOf<Long>())

        override fun start() = recordRuntimeThread()

        override fun evaluate(source: String): RuntimeEvaluation {
            recordRuntimeThread()
            if (source == "fail") error("secret implementation detail")
            if (source == "fatal") host.requestTermination()
            if (source == "schedule-rearm") {
                host.requestWakeup(1_150, 1_000) {
                    wakeupEvents += "cancelled"
                    cancelled.countDown()
                }
                host.requestWakeup(null, 1_000) {}
                host.requestWakeup(1_010, 1_000) {
                    threadGuard.checkAccess()
                    wakeupEvents += "rearmed"
                    wakeupThreadIds += Thread.currentThread().id
                    rearmed.countDown()
                }
            }
            if (source == "schedule-stale") {
                host.requestWakeup(1_100, 1_000) { stale.countDown() }
            }
            return RuntimeEvaluation(RuntimeEvaluation.Kind.NUMBER, id.toString())
        }

        override fun terminateExecution() = Unit

        override fun close() {
            recordRuntimeThread()
            closeCount.incrementAndGet()
        }

        private fun recordRuntimeThread() {
            threadGuard.checkAccess()
            operationThreadIds += Thread.currentThread().id
        }
    }

    private companion object {
        private const val TIMEOUT_SECONDS = 5L

        private fun assertFailsWithCode(
            expectedCode: RuntimeEngineErrorCode,
            future: java.util.concurrent.CompletableFuture<*>,
        ): RuntimeEngineException {
            val error = assertThrows(ExecutionException::class.java) {
                future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            }
            return (error.cause as RuntimeEngineException).also {
                assertEquals(expectedCode, it.code)
            }
        }
    }
}
