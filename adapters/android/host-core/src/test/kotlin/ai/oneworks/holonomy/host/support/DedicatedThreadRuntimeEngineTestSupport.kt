package ai.oneworks.holonomy.host

import java.util.Collections
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows

internal const val TEST_TIMEOUT_SECONDS = 5L

internal class FakeAdapterFactory : RuntimeAdapterFactory {
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

internal class FakeAdapter(
    private val id: Int,
    private val threadGuard: RuntimeThreadGuard,
    private val host: RuntimeAdapterHost,
) : RuntimeAdapter {
    val cancelled = CountDownLatch(1)
    val operationThreadIds = Collections.synchronizedList(mutableListOf<Long>())
    val moduleEvaluations = Collections.synchronizedList(mutableListOf<String>())
    val controls = Collections.synchronizedList(mutableListOf<String>())
    val closeCount = AtomicInteger(0)
    val rearmed = CountDownLatch(1)
    val stale = CountDownLatch(1)
    val cancelledTimer = CountDownLatch(1)
    val staleTimer = CountDownLatch(1)
    val timerFired = CountDownLatch(1)
    val intervalFired = CountDownLatch(1)
    val runtimeBlocked = CountDownLatch(1)
    val releaseRuntime = CountDownLatch(1)
    val deliveredTimerIds = Collections.synchronizedList(mutableListOf<Long>())
    val timerIds = Collections.synchronizedList(mutableListOf<Long>())
    val timerThreadIds = Collections.synchronizedList(mutableListOf<Long>())
    val intervalFireCount = AtomicInteger(0)
    var intervalCancelResult = false
    var timerCancelResult = false
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
        if (source == "timer-once") {
            timerIds += host.scheduleTimer(10, null) { timerId ->
                threadGuard.checkAccess()
                deliveredTimerIds += timerId
                timerThreadIds += Thread.currentThread().id
                timerFired.countDown()
            }
        }
        if (source == "timer-cancel") {
            val timerId = host.scheduleTimer(100, null) { cancelledTimer.countDown() }
            timerCancelResult = host.cancelTimer(timerId)
        }
        if (source == "timer-stale") {
            host.scheduleTimer(100, null) { staleTimer.countDown() }
        }
        if (source == "timer-blocked-interval") {
            host.scheduleTimer(1, 1) { timerId ->
                intervalFireCount.incrementAndGet()
                intervalCancelResult = host.cancelTimer(timerId)
                intervalFired.countDown()
            }
            runtimeBlocked.countDown()
            check(releaseRuntime.await(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        }
        return RuntimeEvaluation(RuntimeEvaluation.Kind.NUMBER, id.toString())
    }

    override fun executeModule(module: RuntimeModuleSource) {
        recordRuntimeThread()
        moduleEvaluations += "module:${module.resourceUrl}"
    }

    override fun control(operation: String, valueJson: String) {
        recordRuntimeThread()
        controls += "$operation:$valueJson"
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

internal fun assertFailsWithCode(
    expectedCode: RuntimeEngineErrorCode,
    future: CompletableFuture<*>,
): RuntimeEngineException {
    val error = assertThrows(ExecutionException::class.java) {
        future.get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }
    return (error.cause as RuntimeEngineException).also {
        assertEquals(expectedCode, it.code)
    }
}
