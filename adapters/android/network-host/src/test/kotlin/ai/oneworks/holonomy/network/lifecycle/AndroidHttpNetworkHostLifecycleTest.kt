package ai.oneworks.holonomy.network

import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidHttpNetworkHostLifecycleTest {
    @Test
    fun `cancellation releases pending DNS admission without a late grant`() {
        val resolver = ControlledResolver()
        val harness = NetworkHostHarness(
            addressResolver = resolver,
            limits = AndroidNetworkLimits(maxChunkBytes = 4, maxConcurrentConnections = 1),
        )
        repeat(3) { index ->
            val id = "request-$index"
            val events = harness.dispatch(
                id = id,
                request = requestJson(id, NetworkV1.REQUEST, requestArgs()),
                context = contextJson("call:$id"),
            )
            assertTrue(events.isEmpty())
            harness.host.cancel("call:$id", "abort")
            val blockedId = "blocked-$index"
            val blocked = harness.dispatch(
                id = blockedId,
                request = requestJson(blockedId, NetworkV1.REQUEST, requestArgs()),
                context = contextJson("call:$blockedId"),
            )
            assertEquals("limit_exceeded", blocked.single().errorCode())
            resolver.acknowledgeCancellation()
            assertTrue(events.isEmpty())
        }
        assertEquals(3, harness.resolveCalls)

        val second = harness.dispatch(
            id = "second",
            request = requestJson("second", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:second"),
        )
        resolver.succeed(listOf(InetAddress.getByName("8.8.8.8")))
        assertEquals("result", second.single().type())
        harness.host.close()
    }

    @Test
    fun `bounded worker rejects backlog and confirms queued tasks during close`() {
        val worker = ExecutorNetworkWorker(1, 1)
        val running = CountDownLatch(1)
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val queuedRan = AtomicBoolean(false)
        assertTrue(worker.execute {
            running.countDown()
            try {
                release.await()
            } catch (_: InterruptedException) {
                // close interrupts running transport work.
            } finally {
                finished.countDown()
            }
        })
        assertTrue(running.await(1, TimeUnit.SECONDS))
        assertTrue(worker.execute { queuedRan.set(true) })
        assertFalse(worker.execute { throw AssertionError("rejected task ran") })

        worker.close()
        release.countDown()
        assertTrue(queuedRan.get())
        assertTrue(finished.await(1, TimeUnit.SECONDS))
    }

    @Test
    fun `dispose during blocked DNS produces no late grant`() {
        val resolver = ControlledResolver()
        val harness = NetworkHostHarness(addressResolver = resolver)
        val events = harness.dispatch(
            id = "request",
            request = requestJson("request", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:request"),
        )
        assertEquals(1, resolver.pendingCount)

        harness.host.close()
        assertEquals(1, resolver.cancelCount)
        resolver.acknowledgeCancellation()
        assertTrue(events.isEmpty())
        assertTrue(harness.resourceEvents.isEmpty())
        assertEquals(1, resolver.closeCount)
    }

    @Test
    fun `DNS deadline settles admission and releases its slot`() {
        val resolver = ControlledResolver()
        val harness = NetworkHostHarness(
            addressResolver = resolver,
            limits = AndroidNetworkLimits(maxChunkBytes = 4, maxConcurrentConnections = 1),
        )
        val events = harness.dispatch(
            id = "deadline",
            request = requestJson(
                "deadline",
                NetworkV1.REQUEST,
                requestArgs(),
                extra = "\"deadlineMs\":1001,",
            ),
            context = contextJson("call:deadline"),
        )
        assertTrue(events.isEmpty())
        assertEquals(1, resolver.lastTimeoutMs)
        resolver.timeout()
        assertEquals("timeout", events.single().errorCode())

        val next = harness.dispatch(
            id = "next",
            request = requestJson("next", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:next"),
        )
        assertTrue(next.isEmpty())
        resolver.succeed(listOf(InetAddress.getByName("8.8.8.8")))
        assertEquals("result", next.single().type())
        harness.host.close()
    }

    @Test
    fun `cancel closes running transport without a late terminal`() {
        val connection = BlockingNetworkConnection()
        val worker = SingleTaskWorker()
        val harness = NetworkHostHarness(connection = connection, worker = worker)
        val resource = harness.openResource()
        harness.resourceCall("open", resource, NetworkV1.OPEN_BODY)
        val finish = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY)
        assertTrue(connection.entered.await(1, TimeUnit.SECONDS))

        harness.host.cancel("call:finish", "abort")
        assertTrue(worker.finished.await(1, TimeUnit.SECONDS))
        assertTrue(finish.isEmpty())
        assertEquals(1, connection.closeCount)
        harness.host.close()
        assertEquals(1, connection.closeCount)
    }

    @Test
    fun `response body stall reaches one timeout terminal and releases its slot`() {
        val socket = StalledBodySocket(
            "HTTP/1.1 200 OK\r\ncontent-length: 1\r\n\r\n".toByteArray(Charsets.ISO_8859_1),
        )
        val connection = PinnedHttp1Connection(
            target = NetworkConnectionTarget(
                address = InetAddress.getByName("8.8.8.8").address,
                host = "example.test",
                hostHeader = "example.test",
                port = 80,
                requestTarget = "/",
                scheme = "http",
            ),
            timeoutMs = 100,
            socketFactory = NetworkSocketFactory { socket },
            tlsLayer = NetworkTlsLayer { _, _, _, _, _ -> throw AssertionError("unexpected TLS") },
        )
        val harness = NetworkHostHarness(
            connection = connection,
            limits = AndroidNetworkLimits(maxChunkBytes = 4, maxConcurrentConnections = 1),
        )
        val resource = harness.openResource()
        harness.resourceCall("open", resource, NetworkV1.OPEN_BODY)
        val response = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY)
        assertEquals(true, response.single().networkValue().get("hasBody"))

        val bodyEvents = harness.resourceCall("read", resource, NetworkV1.READ_BODY, mode = "stream")
        harness.host.grantCredits("call:read", 1)

        assertTrue(socket.bodyReadEntered.await(1, TimeUnit.SECONDS))
        assertEquals(1, bodyEvents.size)
        assertEquals("timeout", bodyEvents.single().errorCode())
        assertEquals(1, socket.closeCount)
        assertEquals(
            "resource_invalid",
            harness.resourceCall("stale", resource, NetworkV1.CLOSE).single().errorCode(),
        )

        val replacement = harness.openResource()
        assertEquals(2, harness.resolveCalls)
        assertEquals(1, bodyEvents.size)
        harness.host.closeResource(replacement.ownerCallToken, replacement.providerToken, "done")
        harness.host.close()
    }

    @Test
    fun `close revokes each live provider resource exactly once`() {
        val harness = NetworkHostHarness()
        harness.openResource()
        harness.host.close()
        assertEquals(1, harness.resourceEvents.size)
        val revoke = JSONObject(harness.resourceEvents.single())
        assertEquals("revoke", revoke.get("type"))
        harness.host.close()
        assertEquals(1, harness.resourceEvents.size)
    }
}
