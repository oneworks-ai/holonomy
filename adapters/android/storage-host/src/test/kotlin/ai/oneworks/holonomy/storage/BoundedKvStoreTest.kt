package ai.oneworks.holonomy.storage

import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import org.junit.Assert.*
import org.junit.Test

class BoundedKvStoreTest {
    private fun directory() = Files.createTempDirectory("kv-store").toRealPath().also {
        Files.setPosixFilePermissions(it, PosixFilePermissions.fromString("rwx------"))
    }

    @Test fun cancelledCommitRetainsOldSnapshotAndRemovesStage() {
        val root = directory()
        val store = BoundedKvStore(root.toFile(), "private", AndroidStorageLimits())
        store.acquire().use {
            store.replace(mapOf("old" to byteArrayOf(1)), {}, { it() })
            try {
                store.replace(mapOf("new" to byteArrayOf(2)), {}, { throw StorageFailure("storage.cancelled") })
                fail("Expected cancelled commit")
            } catch (error: StorageFailure) { assertEquals("storage.cancelled", error.code) }
            assertArrayEquals(byteArrayOf(1), store.read {}["old"])
        }
        assertEquals(2L, Files.list(root).use { it.count() })
    }

    @Test fun namespaceOsLockRejectsConcurrentGenerationThenAllowsReuse() {
        val root = directory()
        val first = BoundedKvStore(root.toFile(), "private", AndroidStorageLimits())
        val second = BoundedKvStore(root.toFile(), "private", AndroidStorageLimits())
        first.acquire().use {
            try { second.acquire().close(); fail("Expected lock conflict") }
            catch (error: StorageFailure) { assertEquals("storage.conflict", error.code) }
        }
        second.acquire().use { second.replace(mapOf("ok" to byteArrayOf(3)), {}, { it() }) }
        first.acquire().use { assertArrayEquals(byteArrayOf(3), first.read {}["ok"]) }
    }

    @Test fun fixedCrashStageIsReplacedWithoutEnumeratingOrGrowingArtifacts() {
        val root = directory()
        val fileName = "kv-${BoundedKvStore.sha256("private".toByteArray())}.bin"
        Files.write(root.resolve("$fileName.pending"), byteArrayOf(9, 9))
        val store = BoundedKvStore(root.toFile(), "private", AndroidStorageLimits())
        store.acquire().use { store.replace(mapOf("ok" to byteArrayOf(1)), {}, { it() }) }
        assertFalse(Files.exists(root.resolve("$fileName.pending")))
        assertEquals(2L, Files.list(root).use { it.count() })
    }

    @Test fun namespaceFilesAreDistinctAndStoreByteCeilingPreservesState() {
        val root = directory()
        val limits = AndroidStorageLimits(maxStoreBytes = 20)
        val first = BoundedKvStore(root.toFile(), "one", limits)
        val second = BoundedKvStore(root.toFile(), "two", limits)
        first.acquire().use {
            first.replace(mapOf("a" to byteArrayOf(1)), {}, { it() })
            try { first.replace(mapOf("a" to ByteArray(8)), {}, { it() }); fail("Expected total quota") }
            catch (error: StorageFailure) { assertEquals("storage.limit_exceeded", error.code) }
        }
        second.acquire().use { assertTrue(second.read {}.isEmpty()) }
        first.acquire().use { assertArrayEquals(byteArrayOf(1), first.read {}["a"]) }
    }

    @Test fun malformedLaterEntryStillFailsAndNeverReplacesCorruptSnapshot() {
        val root = directory()
        val store = BoundedKvStore(root.toFile(), "private", AndroidStorageLimits())
        val file = root.resolve("kv-${BoundedKvStore.sha256("private".toByteArray())}.bin")
        store.acquire().use {
            store.replace(linkedMapOf("first" to byteArrayOf(1, 2), "second" to byteArrayOf(3, 4)), {}, { it() })
            val valid = Files.readAllBytes(file)
            val truncated = valid.copyOf(valid.size - 1)
            Files.write(file, truncated)
            try { store.read {}; fail("Expected corrupt later entry") }
            catch (error: StorageFailure) { assertEquals("storage.internal", error.code) }
            assertArrayEquals(truncated, Files.readAllBytes(file))
        }
    }
}
