package ai.oneworks.holonomy.host.contract

import ai.oneworks.holonomy.host.RuntimeEngineCodeKind
import ai.oneworks.holonomy.host.RuntimeEngineGateDecision
import ai.oneworks.holonomy.host.RuntimeEngineGateRequest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RuntimeEngineGateContractTest {
    @Test
    fun `request owns an immutable bounded source snapshot`() {
        val source = "40 + 2".toByteArray()
        val request = RuntimeEngineGateRequest(RuntimeEngineCodeKind.STRINGS, source, false)
        source.fill(0)

        assertArrayEquals("40 + 2".toByteArray(), request.copySource(1024))
        assertArrayEquals("40".toByteArray(), request.copySource(2))
        assertEquals(6, request.sourceBytes)
        assertEquals(
            "0fcd24935d76f7d5eda64ffde9e33f08079ca2c7e398557915a7e25d60bae721",
            request.sourceSha256,
        )
        assertThrows(IllegalArgumentException::class.java) { request.copySource(-1) }
    }

    @Test
    fun `decision is a closed allow or reasoned deny`() {
        assertEquals(RuntimeEngineGateDecision.Action.ALLOW, RuntimeEngineGateDecision.Allow.action)
        assertEquals(
            RuntimeEngineGateDecision.Action.DENY,
            RuntimeEngineGateDecision.deny("policy.denied").action,
        )
        assertThrows(IllegalArgumentException::class.java) {
            RuntimeEngineGateDecision(RuntimeEngineGateDecision.Action.DENY)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RuntimeEngineGateDecision(RuntimeEngineGateDecision.Action.ALLOW, "unexpected")
        }
    }
}
