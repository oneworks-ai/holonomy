package ai.oneworks.holonomy.v8

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AdbInspectorOptionsTest {
    @Test
    fun `uses stable adb-friendly defaults`() {
        val options = AdbInspectorOptions()

        assertEquals("holonomy_devtools", options.socketName)
        assertEquals("holonomy-runtime", options.targetId)
        assertEquals(64 * 1024 * 1024, options.maxMessageBytes)
    }

    @Test
    fun `rejects unsafe socket target and quota options`() {
        assertThrows(IllegalArgumentException::class.java) {
            AdbInspectorOptions(socketName = "bad socket")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AdbInspectorOptions(targetId = "../bad")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AdbInspectorOptions(targetTitle = "bad\nheader")
        }
        assertThrows(IllegalArgumentException::class.java) {
            AdbInspectorOptions(maxMessageBytes = 1)
        }
    }
}
