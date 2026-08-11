package ai.oneworks.holonomy.host

import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeTimerSchedulerTest {
    @Test
    fun `native timers fire on the runtime thread and cancel with their generation`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val adapter = factory.adapters.single()

        engine.evaluate("timer-once").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertTrue(adapter.timerFired.await(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assertEquals(adapter.operationThreadIds.first(), adapter.timerThreadIds.single())
        assertEquals(adapter.timerIds.single(), adapter.deliveredTimerIds.single())

        engine.evaluate("timer-cancel").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertFalse(adapter.cancelledTimer.await(200, TimeUnit.MILLISECONDS))
        assertTrue(adapter.timerCancelResult)

        engine.evaluate("timer-stale").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.terminate().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertFalse(adapter.staleTimer.await(200, TimeUnit.MILLISECONDS))
        engine.dispose().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    @Test
    fun `interval coalesces while runtime thread is blocked and cancellation drops rearm`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val adapter = factory.adapters.single()

        val blockedOperation = engine.evaluate("timer-blocked-interval")
        assertTrue(adapter.runtimeBlocked.await(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        Thread.sleep(100)
        adapter.releaseRuntime.countDown()
        blockedOperation.get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertTrue(adapter.intervalFired.await(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        Thread.sleep(50)

        assertEquals(1, adapter.intervalFireCount.get())
        assertTrue(adapter.intervalCancelResult)
        engine.dispose().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }
}
