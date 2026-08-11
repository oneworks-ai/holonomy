package ai.oneworks.holonomy.network

import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PinnedHttp1ConnectionWatchdogTest {
    @Test
    fun `absolute watchdog closes a stalled write`() {
        val blockingOutput = BlockingOutput()
        val socket = MemorySocket(ByteArray(0), blockingOutput)
        blockingOutput.closed = socket.closed
        val connection = pinnedConnection(socket = socket, timeoutMs = 50)

        assertThrows(SocketTimeoutException::class.java) {
            connection.execute(emptyTransportRequest(), AndroidNetworkLimits())
        }
        assertTrue(blockingOutput.entered.await(1, TimeUnit.SECONDS))
        assertEquals(1, socket.closeCount)
    }

    @Test
    fun `absolute watchdog closes a stalled TLS handshake seam`() {
        val socket = MemorySocket(ByteArray(0))
        val entered = CountDownLatch(1)
        val tlsLayer = NetworkTlsLayer { _, _, _, _, _ ->
            entered.countDown()
            socket.closedAwait()
            throw SocketException("closed during handshake")
        }
        val connection = pinnedConnection(
            socket = socket,
            target = networkTarget(
                scheme = "https",
                host = "api.example.test",
                hostHeader = "api.example.test",
                port = 443,
            ),
            timeoutMs = 50,
            tlsLayer = tlsLayer,
        )

        assertThrows(SocketTimeoutException::class.java) {
            connection.execute(emptyTransportRequest(), AndroidNetworkLimits())
        }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        assertEquals(1, socket.closeCount)
    }
}
