package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidHttpNetworkHostSecurityTest {
    @Test
    fun `enforces request and response byte quotas before delivery`() {
        val limits = AndroidNetworkLimits(
            maxChunkBytes = 4,
            maxRequestBodyBytes = 4,
            maxResponseBodyBytes = 4,
        )
        val connection = FakeNetworkConnection(body = "12345".toByteArray(), contentLength = 5)
        val harness = NetworkHostHarness(connection = connection, limits = limits)
        val resource = harness.openResource()
        harness.resourceCall("open", resource, NetworkV1.OPEN_BODY)

        val oversizedChunk = harness.resourceCall(
            "large-chunk",
            resource,
            NetworkV1.WRITE_BODY,
            listOf(RuntimeNativeBinary("body:large", ByteArray(5))),
        )
        assertEquals("limit_exceeded", oversizedChunk.single().errorCode())
        val accepted = harness.resourceCall(
            "accepted-chunk",
            resource,
            NetworkV1.WRITE_BODY,
            listOf(RuntimeNativeBinary("body:accepted", ByteArray(4))),
        )
        assertEquals("result", accepted.single().type())
        val aggregate = harness.resourceCall(
            "aggregate",
            resource,
            NetworkV1.WRITE_BODY,
            listOf(RuntimeNativeBinary("body:aggregate", byteArrayOf(1))),
        )
        assertEquals("limit_exceeded", aggregate.single().errorCode())

        val finish = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY).single()
        assertEquals(false, finish.envelope().get("ok"))
        assertEquals("network.response_too_large", finish.envelope().get("error"))
        assertEquals(1, connection.disconnects)
        harness.host.close()
    }

    @Test
    fun `denies private resolved addresses and managed headers`() {
        val denied = NetworkHostHarness(
            addresses = listOf(InetAddress.getByName("127.0.0.1")),
            privateNetwork = PrivateNetworkPolicy.DENY,
        )
        val privateResult = denied.dispatch(
            id = "private",
            request = requestJson("private", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:private"),
        )
        assertEquals("capability_unsupported", privateResult.single().errorCode())
        assertEquals(0, denied.connectionCreates)
        denied.host.close()

        val allowed = NetworkHostHarness()
        val cookieArgs = "{\"headers\":[[\"cookie\",\"secret\"]],\"method\":\"GET\",\"url\":\"http://example.test/\"}"
        val headerResult = allowed.dispatch(
            id = "header",
            request = requestJson("header", NetworkV1.REQUEST, cookieArgs),
            context = contextJson("call:header"),
        )
        assertEquals("invalid_request", headerResult.single().errorCode())
        allowed.host.close()
    }
}
