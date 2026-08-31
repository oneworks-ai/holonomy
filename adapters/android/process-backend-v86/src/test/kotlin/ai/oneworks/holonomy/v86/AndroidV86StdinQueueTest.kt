package ai.oneworks.holonomy.v86

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidV86StdinQueueTest {
    @Test
    fun `write and end before spawn retain their exact order`() {
        val queue = AndroidV86StdinQueue(16)
        val submitted = mutableListOf<Pair<Int, AndroidV86StdinCommand>>()
        val dispatch = { pid: Int, command: AndroidV86StdinCommand -> submitted += pid to command }

        assertTrue(queue.write("input".toByteArray(), 1, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertTrue(queue.end(2, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertTrue(submitted.isEmpty())

        assertEquals(null, queue.attachProcess(42, dispatch))
        assertEquals(listOf("stdin", "end"), submitted.map { it.second.operation })
        assertEquals(listOf(42, 42), submitted.map { it.first })
        assertEquals("input", submitted.first().second.bytes!!.toString(Charsets.UTF_8))
        assertTrue(queue.acknowledge(1))
        assertTrue(queue.acknowledge(2))
        assertFalse(queue.acknowledge(2))
    }

    @Test
    fun `operations after spawn dispatch immediately and end is terminal`() {
        val queue = AndroidV86StdinQueue(4)
        val submitted = mutableListOf<AndroidV86StdinCommand>()
        val dispatch = { _: Int, command: AndroidV86StdinCommand -> submitted += command }

        assertEquals(null, queue.attachProcess(7, dispatch))
        assertTrue(queue.write(byteArrayOf(1, 2, 3, 4), null, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertTrue(queue.end(3, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertEquals(listOf("stdin", "end"), submitted.map(AndroidV86StdinCommand::operation))
        assertEquals(
            "resource.stale",
            (queue.write(byteArrayOf(), null, dispatch) as AndroidV86StdinAdmission.Rejected).code,
        )
        assertEquals(4L, (queue.end(4, dispatch) as AndroidV86StdinAdmission.Accepted).immediateCallbackId)
    }

    @Test
    fun `limits and failed dispatch roll back callback ownership`() {
        val queue = AndroidV86StdinQueue(3)
        val failingDispatch = { _: Int, _: AndroidV86StdinCommand -> error("backend stopped") }

        assertEquals(null, queue.attachProcess(8) { _, _ -> })
        assertEquals(
            "resource.byte_limit",
            (queue.write(byteArrayOf(1, 2, 3, 4), 5) { _, _ -> } as AndroidV86StdinAdmission.Rejected).code,
        )
        assertEquals(
            "provider.unavailable",
            (queue.write(byteArrayOf(1), 6, failingDispatch) as AndroidV86StdinAdmission.Rejected).code,
        )
        assertTrue(queue.close().isEmpty())
    }
}
