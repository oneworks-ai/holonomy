package ai.oneworks.holonomy.storage

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AndroidStorageNativeHostTest {
    private fun root() = Files.createTempDirectory("storage-test").toRealPath().also {
        Files.setPosixFilePermissions(it, PosixFilePermissions.fromString("rwx------"))
    }.toFile()

    private fun host(directory: java.io.File, limits: AndroidStorageLimits = AndroidStorageLimits(), generation: Long = 1) =
        AndroidStorageNativeHost(AndroidStorageHostConfiguration(directory, "host-private", "principal", generation, limits))

    private fun context(operation: String, token: String, prefix: String = "allowed/", principal: String = "principal") =
        JSONObject().put("callToken", token).put("mode", "result").put("resources", JSONArray())
            .put("authority", JSONObject().put("principal", principal).put("capabilities", JSONArray(listOf("host.storage.v1"))))
            .put("storageSelection", JSONObject().put("namespaceId", "default").put("operation", "storage.${operation.removePrefix("v1.")}")
                .put("databases", JSONArray()).put("keyPrefixes", JSONArray(listOf(prefix)))
                .put("limits", JSONObject().put("maxKeyBytes", 1024).put("maxValueBytes", 1024 * 1024)
                    .put("maxKeysPerList", 1024).put("maxPendingOperations", 128))).toString()

    private fun submit(host: AndroidStorageNativeHost, operation: String, key: String = "allowed/key", value: ByteArray? = null,
        token: String = "call", prefix: String = "allowed/", principal: String = "principal"): CompletableFuture<RuntimeNativeEvent> {
        val output = CompletableFuture<RuntimeNativeEvent>()
        val args = JSONObject().put(if (operation == "v1.kv.list") "prefix" else "key", key)
        val request = JSONObject().put("id", token).put("module", "host.storage").put("operation", operation).put("args", args)
        val providerContext = JSONObject(context(operation, token, prefix, principal))
        if (value != null) providerContext.put("storageValue", JSONObject().put("byteLength", value.size)
            .put("sha256", BoundedKvStore.sha256(value)))
        host.dispatch(token, request.toString(), providerContext.toString(),
            value?.let { listOf(RuntimeNativeBinary("value", it)) } ?: emptyList(),
            RuntimeNativeEventSink { output.complete(it) }, RuntimeNativeResourceEventSink {})
        return output
    }

    private fun await(future: CompletableFuture<RuntimeNativeEvent>) = future.get(5, TimeUnit.SECONDS)
    private fun envelope(event: RuntimeNativeEvent) = JSONObject(event.eventJson).get("value") as JSONObject
    private fun code(event: RuntimeNativeEvent) = (envelope(event).get("error") as JSONObject).get("code")

    @Test fun binaryPersistsAcrossFreshGenerationAndKeysNeverBecomePaths() {
        val directory = root()
        val first = host(directory)
        val bytes = byteArrayOf(0, -1, 42, 0)
        assertTrue(envelope(await(submit(first, "v1.kv.set", "allowed/../../escape", bytes))).get("ok") == true)
        first.close()
        host(directory, generation = 2).use { second ->
            val event = await(submit(second, "v1.kv.get", "allowed/../../escape"))
            assertEquals(true, envelope(event).get("value"))
            assertArrayEquals(bytes, event.binary.single().data)
            val listed = envelope(await(submit(second, "v1.kv.list", "allowed/"))).get("value") as JSONArray
            assertEquals("allowed/../../escape", listed.get(0))
            assertEquals(true, envelope(await(submit(second, "v1.kv.delete", "allowed/../../escape"))).get("value"))
            assertEquals(false, envelope(await(submit(second, "v1.kv.delete", "allowed/../../escape"))).get("value"))
            assertTrue(await(submit(second, "v1.kv.get", "allowed/../../escape")).binary.isEmpty())
        }
        assertEquals(2, directory.listFiles()!!.size)
    }

    @Test fun reauthorizesPrincipalAndPrefixWithoutLeakingPaths() {
        val directory = root()
        host(directory).use { host ->
            assertEquals("storage.authorization_denied", code(await(submit(host, "v1.kv.set", "secret", byteArrayOf(1)))))
            val denied = await(submit(host, "v1.kv.get", principal = "other"))
            assertEquals("storage.authorization_denied", code(denied))
            assertFalse(denied.eventJson.contains(directory.path))
            assertFalse(host.configurationJson().contains(directory.path))
        }
        assertTrue(directory.listFiles()!!.isEmpty())
    }

    @Test fun hardLimitsKeepPreviousAtomicValueAndDoNotTruncateLists() {
        val directory = root()
        host(directory, AndroidStorageLimits(maxValueBytes = 8, maxKeysPerList = 1, maxEntries = 2)).use { host ->
            await(submit(host, "v1.kv.set", "allowed/a", byteArrayOf(1)))
            await(submit(host, "v1.kv.set", "allowed/b", byteArrayOf(2)))
            assertEquals("storage.limit_exceeded", code(await(submit(host, "v1.kv.set", "allowed/c", byteArrayOf(3)))))
            assertEquals("storage.limit_exceeded", code(await(submit(host, "v1.kv.set", "allowed/a", ByteArray(9)))))
            assertArrayEquals(byteArrayOf(1), await(submit(host, "v1.kv.get", "allowed/a")).binary.single().data)
            assertEquals("storage.limit_exceeded", code(await(submit(host, "v1.kv.list", "allowed/"))))
        }
        assertEquals(2, directory.listFiles()!!.size)
    }

    @Test fun cancelledQueuedCallCannotWriteOrEmitAndQueueIsBounded() {
        val directory = root()
        val host = host(directory, AndroidStorageLimits(maxPendingOperations = 1))
        val field = AndroidStorageNativeHost::class.java.getDeclaredField("worker").apply { isAccessible = true }
        val worker = field.get(host) as ThreadPoolExecutor
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        worker.execute { started.countDown(); release.await() }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        val cancelled = submit(host, "v1.kv.set", value = byteArrayOf(1), token = "cancelled")
        assertEquals("storage.limit_exceeded", code(await(submit(host, "v1.kv.get", token = "overflow"))))
        host.cancel("cancelled", "test")
        release.countDown()
        worker.submit {}.get(2, TimeUnit.SECONDS)
        assertFalse(cancelled.isDone)
        assertTrue(directory.listFiles()!!.isEmpty())
        host.close()
        assertEquals("storage.disposed", code(await(submit(host, "v1.kv.get"))))
    }

    @Test fun closeFencesQueuedGenerationAndUnsupportedRemainsExplicit() {
        val directory = root()
        val host = host(directory)
        assertEquals("storage.not_supported", code(await(submit(host, "v1.sqlite.query"))))
        assertEquals("storage.not_supported", code(await(submit(host, "v1.credential.open"))))
        val field = AndroidStorageNativeHost::class.java.getDeclaredField("worker").apply { isAccessible = true }
        val worker = field.get(host) as ThreadPoolExecutor
        val started = CountDownLatch(1)
        worker.execute { started.countDown(); try { CountDownLatch(1).await() } catch (_: InterruptedException) {} }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        val queued = submit(host, "v1.kv.set", value = byteArrayOf(1))
        host.close()
        assertTrue(worker.awaitTermination(2, TimeUnit.SECONDS))
        assertFalse(queued.isDone)
        assertTrue(directory.listFiles()!!.isEmpty())
    }

    @Test fun corruptAndSymlinkStorageFailClosedWithoutReplacingTarget() {
        val directory = root()
        val file = directory.toPath().resolve("kv-${BoundedKvStore.sha256("host-private".toByteArray())}.bin")
        Files.write(file, byteArrayOf(1, 2, 3))
        host(directory).use { host -> assertEquals("storage.internal", code(await(submit(host, "v1.kv.set", value = byteArrayOf(4))))) }
        assertArrayEquals(byteArrayOf(1, 2, 3), Files.readAllBytes(file))
        Files.delete(file)
        val target = Files.createTempFile("storage-target", ".bin")
        Files.write(target, byteArrayOf(9))
        Files.createSymbolicLink(file, target)
        host(directory).use { host -> assertEquals("storage.internal", code(await(submit(host, "v1.kv.get")))) }
        assertArrayEquals(byteArrayOf(9), Files.readAllBytes(target))
    }

    @Test fun rejectsPayloadThatDiffersFromBrokerCommitmentBeforeDiskWork() {
        val directory = root()
        host(directory).use { host ->
            val result = CompletableFuture<RuntimeNativeEvent>()
            val request = JSONObject().put("id", "mismatch").put("module", "host.storage").put("operation", "v1.kv.set")
                .put("args", JSONObject().put("key", "allowed/key"))
            val context = JSONObject(context("v1.kv.set", "mismatch")).put("storageValue", JSONObject()
                .put("byteLength", 1).put("sha256", BoundedKvStore.sha256(byteArrayOf(1))))
            host.dispatch("mismatch", request.toString(), context.toString(), listOf(RuntimeNativeBinary("value", byteArrayOf(2))),
                RuntimeNativeEventSink { result.complete(it) }, RuntimeNativeResourceEventSink {})
            assertEquals("storage.authorization_denied", code(await(result)))
            assertTrue(directory.listFiles()!!.isEmpty())
        }
    }

    @Test fun missingOutOfBandSelectionCannotBeReplacedByGuestArgs() {
        val directory = root()
        host(directory).use { host ->
            val result = CompletableFuture<RuntimeNativeEvent>()
            val request = JSONObject().put("id", "missing").put("module", "host.storage").put("operation", "v1.kv.get")
                .put("args", JSONObject().put("key", "allowed/key"))
            val providerContext = JSONObject().put("callToken", "missing").put("mode", "result").put("resources", JSONArray())
                .put("authority", JSONObject().put("principal", "principal").put("capabilities", JSONArray(listOf("host.storage.v1"))))
            host.dispatch("missing", request.toString(), providerContext.toString(), emptyList(),
                RuntimeNativeEventSink { result.complete(it) }, RuntimeNativeResourceEventSink {})
            assertEquals("storage.authorization_denied", code(await(result)))
            assertTrue(directory.listFiles()!!.isEmpty())
        }
    }
}
