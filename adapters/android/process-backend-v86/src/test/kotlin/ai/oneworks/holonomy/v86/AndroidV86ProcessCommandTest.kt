package ai.oneworks.holonomy.v86

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidV86ProcessCommandTest {
    @Test
    fun `program invocation preserves fixed arguments before public argv`() {
        assertEquals(
            listOf("--fixed", "one", "two"),
            buildAndroidV86CommandArgs("program", listOf("--fixed"), listOf("one", "two"), null),
        )
    }

    @Test
    fun `shell invocation adds exactly one command boundary`() {
        assertEquals(
            listOf("--noprofile", "-c", "printf first"),
            buildAndroidV86CommandArgs("shell", listOf("--noprofile"), emptyList(), "printf first"),
        )
        assertEquals(null, buildAndroidV86CommandArgs("shell", emptyList(), emptyList(), null))
        assertEquals(null, buildAndroidV86CommandArgs("unknown", emptyList(), emptyList(), null))
    }

    @Test
    fun `process timeout inherits and tightens the policy ceiling`() {
        assertEquals(120_000, effectiveAndroidV86ProcessTimeoutMs(null, 120_000))
        assertEquals(50, effectiveAndroidV86ProcessTimeoutMs(50, 120_000))
        assertEquals(120_000, effectiveAndroidV86ProcessTimeoutMs(240_000, 120_000))
    }

    @Test
    fun `terminal signal intent can strengthen but never downgrade SIGKILL`() {
        assertEquals("SIGTERM", strongerAndroidV86Signal("SIGINT", "SIGTERM"))
        assertEquals("SIGKILL", strongerAndroidV86Signal("SIGTERM", "SIGKILL"))
        assertEquals("SIGKILL", strongerAndroidV86Signal("SIGKILL", "SIGTERM"))
        assertEquals("SIGKILL", strongerAndroidV86Signal("SIGKILL", "SIGINT"))
    }
}
