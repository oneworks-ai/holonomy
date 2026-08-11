package ai.oneworks.holonomy.host

import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DedicatedThreadRuntimeEngineLifecycleTest {
    @Test
    fun `wakeups coalesce rearm and stay generation bound`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val first = factory.adapters.single()

        engine.evaluate("schedule-rearm").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertTrue(first.rearmed.await(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assertFalse(first.cancelled.await(200, TimeUnit.MILLISECONDS))
        assertEquals(listOf("rearmed"), first.wakeupEvents)
        assertEquals(first.operationThreadIds.first(), first.wakeupThreadIds.single())

        engine.evaluate("schedule-stale").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.terminate().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertFalse(first.stale.await(200, TimeUnit.MILLISECONDS))
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertEquals(2, factory.adapters.size)
        engine.dispose().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    @Test
    fun `fatal callbacks terminate after unwind and disposal cancels races`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)

        assertFailsWithCode(RuntimeEngineErrorCode.TERMINATED, engine.evaluate("fatal"))
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val recreated = factory.adapters.last()
        engine.evaluate("schedule-stale").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.dispose().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertFalse(recreated.stale.await(200, TimeUnit.MILLISECONDS))
        assertEquals(2, factory.adapters.size)
    }
}
