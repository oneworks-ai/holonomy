package ai.oneworks.holonomy.v86

import org.junit.Assert.assertEquals
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
        assertEquals(listOf("stdin"), submitted.map { it.second.operation })
        assertEquals(listOf(42), submitted.map { it.first })
        assertEquals("input", submitted.first().second.bytes!!.toString(Charsets.UTF_8))
        val write = submitted.first().second
        assertEquals(1L, queue.acknowledge(write.sequence, "stdin", 1, dispatch)?.callbackId)
        assertEquals(listOf("stdin", "end"), submitted.map { it.second.operation })
        assertEquals(listOf(42, 42), submitted.map { it.first })
        val end = submitted.last().second
        assertEquals(2L, queue.acknowledge(end.sequence, "end", 2, dispatch)?.callbackId)
        assertEquals(null, queue.acknowledge(end.sequence, "end", 2, dispatch))
    }

    @Test
    fun `operations after spawn dispatch immediately and end is terminal`() {
        val queue = AndroidV86StdinQueue(4)
        val submitted = mutableListOf<AndroidV86StdinCommand>()
        val dispatch = { _: Int, command: AndroidV86StdinCommand -> submitted += command }

        assertEquals(null, queue.attachProcess(7, dispatch))
        assertTrue(queue.write(byteArrayOf(1, 2, 3, 4), null, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertTrue(queue.end(3, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertEquals(listOf("stdin"), submitted.map(AndroidV86StdinCommand::operation))
        val write = submitted.single()
        assertEquals(null, queue.acknowledge(write.sequence, "end", null, dispatch))
        assertEquals(null, queue.acknowledge(write.sequence, "stdin", 99, dispatch))
        assertEquals(listOf("stdin"), submitted.map(AndroidV86StdinCommand::operation))
        assertTrue(queue.acknowledge(write.sequence, "stdin", null, dispatch) != null)
        assertEquals(listOf("stdin", "end"), submitted.map(AndroidV86StdinCommand::operation))
        assertEquals(null, queue.acknowledge(write.sequence, "stdin", null, dispatch))
        assertEquals(3L, queue.acknowledge(submitted.last().sequence, "end", 3, dispatch)?.callbackId)
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

    @Test
    fun `close fences queued commands and late acknowledgements`() {
        val queue = AndroidV86StdinQueue(16)
        val submitted = mutableListOf<AndroidV86StdinCommand>()
        val dispatch = { _: Int, command: AndroidV86StdinCommand -> submitted += command }

        assertTrue(queue.write(byteArrayOf(1), 1, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertTrue(queue.end(2, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertEquals(null, queue.attachProcess(42, dispatch))
        assertEquals(listOf("stdin"), submitted.map(AndroidV86StdinCommand::operation))
        assertEquals(listOf(1L, 2L), queue.close())
        assertEquals(null, queue.acknowledge(submitted.single().sequence, "stdin", 1, dispatch))
        assertTrue(queue.attachProcess(43, dispatch) is IllegalStateException)
        assertEquals(listOf("stdin"), submitted.map(AndroidV86StdinCommand::operation))
        assertTrue(queue.close().isEmpty())
    }

    @Test
    fun `reentrant acknowledgement does not nest dispatcher calls`() {
        val queue = AndroidV86StdinQueue(16)
        val submitted = mutableListOf<AndroidV86StdinCommand>()
        var depth = 0
        lateinit var dispatch: (Int, AndroidV86StdinCommand) -> Unit
        dispatch = { _: Int, command: AndroidV86StdinCommand ->
            depth += 1
            assertEquals(1, depth)
            submitted += command
            queue.acknowledge(command.sequence, command.operation, command.callbackId, dispatch)
            depth -= 1
        }

        assertTrue(queue.write(byteArrayOf(1), 1, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertTrue(queue.end(2, dispatch) is AndroidV86StdinAdmission.Accepted)
        assertEquals(null, queue.attachProcess(42, dispatch))
        assertEquals(listOf("stdin", "end"), submitted.map(AndroidV86StdinCommand::operation))
        assertTrue(queue.close().isEmpty())
    }
}
