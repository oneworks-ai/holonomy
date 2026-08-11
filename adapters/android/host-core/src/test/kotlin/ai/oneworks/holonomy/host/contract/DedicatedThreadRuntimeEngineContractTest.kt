package ai.oneworks.holonomy.host

import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

class DedicatedThreadRuntimeEngineContractTest {
    @Test
    fun `operations stay on one dedicated thread and disposal is idempotent`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)

        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.executeModule(RuntimeModuleSource("memory://device/entry.mjs", "export const value = 1"))
            .get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        engine.control("network.rules.replace", "{\"mode\":\"passthrough\",\"rules\":[]}")
            .get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertEquals(
            RuntimeEvaluation(RuntimeEvaluation.Kind.NUMBER, "1"),
            engine.evaluate("engine-id").get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS),
        )
        val firstDispose = engine.dispose()
        assertSame(firstDispose, engine.dispose())
        firstDispose.get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)

        assertEquals(1, factory.adapters.size)
        assertEquals(1, factory.adapters.single().operationThreadIds.toSet().size)
        assertEquals(listOf("module:memory://device/entry.mjs"), factory.adapters.single().moduleEvaluations)
        assertEquals(
            listOf("network.rules.replace:{\"mode\":\"passthrough\",\"rules\":[]}"),
            factory.adapters.single().controls,
        )
        assertFalse(factory.adapters.single().operationThreadIds.contains(Thread.currentThread().id))
        assertEquals(1, factory.adapters.single().closeCount.get())
        assertFailsWithCode(RuntimeEngineErrorCode.DISPOSED, engine.evaluate("1 + 1"))
    }

    @Test
    fun `trusted controls reject invalid operations and oversized values before adapter dispatch`() {
        val factory = FakeAdapterFactory()
        val engine = DedicatedThreadRuntimeEngine(factory)
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)

        assertFailsWithCode(RuntimeEngineErrorCode.INVALID_ARGUMENT, engine.control("bad control", "{}"))
        assertFailsWithCode(RuntimeEngineErrorCode.INVALID_ARGUMENT, engine.control("network.rules.replace", ""))
        assertEquals(emptyList<String>(), factory.adapters.single().controls)
        engine.dispose().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }

    @Test
    fun `unknown adapter failures are redacted`() {
        val engine = DedicatedThreadRuntimeEngine(FakeAdapterFactory())
        engine.start().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)

        val error = assertFailsWithCode(RuntimeEngineErrorCode.INTERNAL, engine.evaluate("fail"))
        assertEquals("The runtime engine operation failed", error.message)
        engine.dispose().get(TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    }
}
