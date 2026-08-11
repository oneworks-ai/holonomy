package ai.oneworks.holonomy.session

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class LengthPrefixedSessionFramesTest {
    @Test
    fun `frame round trips with a big endian length prefix`() {
        val payload = "session-v2".toByteArray()
        val output = ByteArrayOutputStream()

        LengthPrefixedSessionFrames.write(output, payload, 1024)
        val framed = output.toByteArray()

        assertEquals(0, framed[0].toInt())
        assertEquals(payload.size, framed[3].toInt())
        assertArrayEquals(payload, LengthPrefixedSessionFrames.read(ByteArrayInputStream(framed), 1024))
    }

    @Test
    fun `invalid or truncated frames fail closed`() {
        assertThrows(IllegalArgumentException::class.java) {
            LengthPrefixedSessionFrames.write(ByteArrayOutputStream(), ByteArray(5), 4)
        }
        assertThrows(IllegalArgumentException::class.java) {
            LengthPrefixedSessionFrames.read(ByteArrayInputStream(byteArrayOf(0, 0, 1, 0)), 32)
        }
        assertThrows(EOFException::class.java) {
            LengthPrefixedSessionFrames.read(ByteArrayInputStream(byteArrayOf(0, 0, 0, 2, 1)), 32)
        }
    }

    @Test
    fun `ingress command ids are random 128-bit hex values`() {
        val ids = List(100) { SessionIngressCommandIds.random() }

        assertEquals(100, ids.toSet().size)
        ids.forEach { commandId ->
            assertEquals(32, commandId.value.length)
            SessionIngressCommandIds.requireRandom(commandId)
        }
        assertThrows(IllegalArgumentException::class.java) {
            SessionIngressCommandIds.requireRandom(CommandId("predictable"))
        }
    }
}
