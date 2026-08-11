package ai.oneworks.holonomy.network

import java.net.InetAddress
import java.net.InetSocketAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PinnedHttp1ConnectionTest {
    @Test
    fun `connects exact address and writes bounded HTTP while decoding chunked redirect`() {
        val wireResponse = (
            "HTTP/1.1 103 Early Hints\r\nlink: </asset>\r\n\r\n" +
                "HTTP/1.1 302 Found\r\nlocation: https://next.test/\r\ntransfer-encoding: chunked\r\n\r\n" +
                "4\r\npong\r\n0\r\nx-trailer: complete\r\n\r\n"
        ).toByteArray(Charsets.ISO_8859_1)
        val socket = MemorySocket(wireResponse)
        val address = InetAddress.getByName("2001:4860:4860::8888").address
        val connection = pinnedConnection(
            socket = socket,
            target = networkTarget(
                address = address,
                host = "2001:4860:4860::8888",
                hostHeader = "[2001:4860:4860::8888]:8080",
                port = 8080,
                requestTarget = "/submit?q=1",
            ),
        )

        val response = connection.execute(
            NetworkTransportRequest(
                bodyLength = 4,
                chunks = listOf("ping".toByteArray()),
                headers = listOf("x-request" to "yes"),
                method = "POST",
            ),
            AndroidNetworkLimits(),
        )

        assertEquals(302, response.status)
        assertEquals("https://next.test/", response.headers.first { it.first == "location" }.second)
        assertEquals("pong", response.body?.readBytes()?.toString(Charsets.UTF_8))
        val connected = socket.connectedAddress as InetSocketAddress
        assertTrue(connected.address.address.contentEquals(address))
        assertEquals(8080, connected.port)
        val request = socket.written.toString(Charsets.ISO_8859_1.name())
        assertTrue(request.startsWith("POST /submit?q=1 HTTP/1.1\r\n"))
        assertTrue(request.contains("host: [2001:4860:4860::8888]:8080\r\n"))
        assertTrue(request.contains("accept-encoding: identity\r\n"))
        assertTrue(request.contains("connection: close\r\n"))
        assertTrue(request.contains("content-length: 4\r\n"))
        assertTrue(request.endsWith("\r\nping"))
        assertEquals(1, socket.closeCount)
    }

    @Test
    fun `rejects conflicting response framing and closes transport`() {
        val response = (
            "HTTP/1.1 200 OK\r\ncontent-length: 4\r\ntransfer-encoding: chunked\r\n\r\n" +
                "4\r\ntest\r\n0\r\n\r\n"
        ).toByteArray(Charsets.ISO_8859_1)
        val socket = MemorySocket(response)
        val connection = pinnedConnection(socket)

        assertThrows(HttpProtocolException::class.java) {
            connection.execute(emptyTransportRequest(), AndroidNetworkLimits())
        }
        assertEquals(1, socket.closeCount)
    }

    @Test
    fun `passes original hostname and strict HTTPS identity policy to TLS seam`() {
        val socket = MemorySocket("HTTP/1.1 204 No Content\r\n\r\n".toByteArray())
        var capturedPolicy: NetworkTlsPolicy? = null
        val tlsLayer = NetworkTlsLayer { raw, policy, _, _, activate ->
            capturedPolicy = policy
            activate(raw)
            raw
        }
        val connection = pinnedConnection(
            socket = socket,
            target = networkTarget(
                scheme = "https",
                host = "api.example.test",
                hostHeader = "api.example.test",
                port = 443,
            ),
            tlsLayer = tlsLayer,
        )

        val response = connection.execute(emptyTransportRequest(), AndroidNetworkLimits())

        assertEquals(204, response.status)
        assertEquals(null, response.body)
        assertEquals("api.example.test", capturedPolicy?.hostname)
        assertEquals("api.example.test", capturedPolicy?.serverName)
        assertEquals("HTTPS", capturedPolicy?.endpointIdentificationAlgorithm)
        assertEquals(1, socket.closeCount)
    }
}
