package ai.oneworks.holonomy.capability

import java.io.File
import java.nio.channels.NonWritableChannelException
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AndroidFilesystemOpenFileTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun `portable readonly opens existing content without a write capable channel`() {
        val target = existing()
        open(target, portable("read")).use { file ->
            val bytes = ByteArray(6)
            file.readFully(bytes)
            assertEquals("before", bytes.toString(Charsets.UTF_8))
            assertThrows(NonWritableChannelException::class.java) { file.write(byteArrayOf(1)) }
        }
        assertEquals("before", target.readText())
    }

    @Test
    fun `write create preserves existing tail and creates a missing target`() {
        val target = existing()
        open(target, portable("write", create = true)).use { file ->
            assertEquals(6L, file.length())
            file.write("X".toByteArray())
        }
        assertEquals("Xefore", target.readText())
        val missing = File(temporary.root, "created")
        open(missing, portable("write", create = true)).use { it.write("new".toByteArray()) }
        assertEquals("new", missing.readText())
    }

    @Test
    fun `readwrite preserves content and supports positioned read and write`() {
        val target = existing()
        open(target, portable("readWrite")).use { file ->
            file.seek(2)
            file.write("!".toByteArray())
            file.seek(1)
            val bytes = ByteArray(3)
            assertEquals(3, file.read(bytes))
            assertEquals("e!o", bytes.toString(Charsets.UTF_8))
        }
        assertEquals("be!ore", target.readText())
    }

    @Test
    fun `read create can create but handle rights stay read only`() {
        val target = File(temporary.root, "created-read")
        val flag = AndroidFilesystemOpenFlag.parse(portable("read", create = true))
        AndroidFilesystemOpenFile.open(target, flag).use { assertEquals(0L, it.length()) }
        assertTrue(target.exists())
        assertEquals(setOf("read"), flag.handleRights)
        assertEquals(setOf("read", "write"), flag.requiredRights)
    }

    @Test
    fun `truncate occurs only when explicitly selected`() {
        val target = existing()
        open(target, portable("write", truncate = true)).use { assertEquals(0L, it.length()) }
        assertEquals("", target.readText())
    }

    @Test
    fun `append preserves content and overrides even positioned offsets`() {
        val target = existing()
        open(target, portable("readWrite", append = true)).use { file ->
            file.seek(0)
            file.write("!".toByteArray())
            file.seek(1)
            file.write("?".toByteArray())
            file.sync()
        }
        assertEquals("before!?", target.readText())
    }

    @Test
    fun `truncate and append are independent and compose`() {
        val target = existing()
        open(target, portable("write", truncate = true, append = true)).use { file ->
            assertEquals(0L, file.length())
            file.write("!".toByteArray())
            file.seek(0)
            file.write("?".toByteArray())
        }
        assertEquals("!?", target.readText())
    }

    @Test
    fun `exclusive existing target fails without truncation and missing target succeeds`() {
        val fields = portable("write", create = true, exclusive = true, truncate = true)
        val target = existing()
        assertCode("resource.exists") { open(target, fields).close() }
        assertEquals("before", target.readText())
        val missing = File(temporary.root, "exclusive")
        open(missing, fields).use { it.write("created".toByteArray()) }
        assertEquals("created", missing.readText())
    }

    @Test
    fun `exclusive create has exactly one winner under simultaneous opens`() {
        val target = File(temporary.root, "race")
        val executor = Executors.newFixedThreadPool(2)
        val ready = CountDownLatch(2)
        val start = CountDownLatch(1)
        try {
            val futures = (1..2).map {
                executor.submit(Callable {
                    ready.countDown()
                    check(start.await(5, TimeUnit.SECONDS))
                    try {
                        open(target, portable("write", create = true, exclusive = true)).use { it.write("winner".toByteArray()) }
                        "opened"
                    } catch (failure: ProviderFailure) {
                        failure.code
                    }
                })
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            start.countDown()
            assertEquals(listOf("opened", "resource.exists"), futures.map { it.get(5, TimeUnit.SECONDS) }.sorted())
            assertEquals("winner", target.readText())
        } finally {
            start.countDown()
            executor.shutdownNow()
        }
    }

    @Test
    fun `no-create missing targets are never created for any access`() {
        for (access in listOf("read", "write", "readWrite")) {
            val target = File(temporary.root, access)
            assertCode("resource.not_found") { open(target, portable(access)).close() }
            assertFalse(target.exists())
        }
        for (effect in listOf("truncate", "append")) {
            val target = File(temporary.root, effect)
            assertCode("resource.not_found") { open(target, portable("write") + (effect to true)).close() }
            assertFalse(target.exists())
        }
    }

    @Test
    fun `Node string open behavior retains read write append and exclusive semantics`() {
        for (string in listOf("r", "r+", "w", "w+", "wx", "wx+", "a", "a+", "ax", "ax+")) {
            val target = File(temporary.root, "string-$string")
            if (string.startsWith("r")) target.writeText("before")
            AndroidFilesystemOpenFile.open(target, AndroidFilesystemOpenFlag.parse(string)).use { file ->
                if (!string.startsWith("r")) file.write("X".toByteArray())
            }
            assertEquals(if (string.startsWith("r")) "before" else "X", target.readText())
            if (string.contains('x')) assertCode("resource.exists") {
                AndroidFilesystemOpenFile.open(target, AndroidFilesystemOpenFlag.parse(string)).close()
            }
        }
        for (string in listOf("r", "r+")) assertCode("resource.not_found") {
            AndroidFilesystemOpenFile.open(File(temporary.root, "missing-$string"), AndroidFilesystemOpenFlag.parse(string)).close()
        }
    }

    @Test
    fun `publication failure closes the opened descriptor and preserves the failure`() {
        var opened: AndroidFilesystemOpenFile? = null
        val failure = assertThrows(ProviderFailure::class.java) {
            publishFilesystemOpen(existing(), AndroidFilesystemOpenFlag.parse("r")) { file ->
                opened = file
                throw ProviderFailure("provider.protocol_error")
            }
        }
        assertEquals("provider.protocol_error", failure.code)
        assertFalse(opened!!.isOpen)
    }

    @Test
    fun `successful publication transfers descriptor ownership to the ledger`() {
        val opened = publishFilesystemOpen(existing(), AndroidFilesystemOpenFlag.parse("r")) { it }
        try { assertTrue(opened.isOpen) } finally { opened.close() }
        assertFalse(opened.isOpen)
    }

    private fun existing(): File = temporary.newFile().apply { writeText("before") }

    private fun open(target: File, fields: Map<String, Any>): AndroidFilesystemOpenFile =
        AndroidFilesystemOpenFile.open(target, AndroidFilesystemOpenFlag.parse(fields))

    private fun assertCode(code: String, action: () -> Unit) {
        assertEquals(code, assertThrows(ProviderFailure::class.java, action).code)
    }
}
