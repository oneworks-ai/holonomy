package ai.oneworks.holonomy.network

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal fun pinnedConnection(
    socket: MemorySocket,
    target: NetworkConnectionTarget = networkTarget(),
    timeoutMs: Int = 1_000,
    tlsLayer: NetworkTlsLayer = NetworkTlsLayer { _, _, _, _, _ -> throw AssertionError("unexpected TLS") },
) = PinnedHttp1Connection(target, timeoutMs, NetworkSocketFactory { socket }, tlsLayer)

internal fun networkTarget(
    address: ByteArray = InetAddress.getByName("8.8.8.8").address,
    host: String = "example.test",
    hostHeader: String = "example.test",
    port: Int = 80,
    requestTarget: String = "/",
    scheme: String = "http",
) = NetworkConnectionTarget(address, host, hostHeader, port, requestTarget, scheme)

internal fun emptyTransportRequest() = NetworkTransportRequest(0, emptyList(), emptyList(), "GET")

internal class MemorySocket(
    response: ByteArray,
    private val output: OutputStream = ByteArrayOutputStream(),
) : Socket() {
    val closed = CountDownLatch(1)
    val written: ByteArrayOutputStream
        get() = output as ByteArrayOutputStream
    var closeCount = 0
        private set
    var connectedAddress: SocketAddress? = null
        private set
    private val input = ByteArrayInputStream(response)
    private val closedOnce = AtomicBoolean(false)

    override fun connect(endpoint: SocketAddress, timeout: Int) {
        connectedAddress = endpoint
    }

    override fun getInputStream(): InputStream = input

    override fun getOutputStream(): OutputStream = output

    override fun setSoTimeout(timeout: Int) = Unit

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun close() {
        if (!closedOnce.compareAndSet(false, true)) return
        closeCount += 1
        closed.countDown()
    }

    fun closedAwait() {
        check(closed.await(1, TimeUnit.SECONDS))
    }
}

internal class BlockingOutput : OutputStream() {
    val entered = CountDownLatch(1)
    lateinit var closed: CountDownLatch

    override fun write(value: Int) = block()

    override fun write(buffer: ByteArray, offset: Int, length: Int) = block()

    private fun block(): Nothing {
        entered.countDown()
        check(closed.await(1, TimeUnit.SECONDS))
        throw SocketException("closed during write")
    }
}
