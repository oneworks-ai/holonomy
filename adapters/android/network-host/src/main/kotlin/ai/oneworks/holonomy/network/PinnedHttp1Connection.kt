package ai.oneworks.holonomy.network

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

internal const val MAX_HTTP_REQUEST_CHUNKS = 4096

internal data class NetworkConnectionTarget(
    val address: ByteArray,
    val host: String,
    val hostHeader: String,
    val port: Int,
    val requestTarget: String,
    val scheme: String,
) {
    init {
        require(address.size == 4 || address.size == 16)
        require(port in 1..65_535)
        require(scheme == "http" || scheme == "https")
    }
}

internal data class NetworkTlsPolicy(
    val endpointIdentificationAlgorithm: String,
    val hostname: String,
    val serverName: String?,
)

internal data class NetworkTransportRequest(
    val bodyLength: Long,
    val chunks: List<ByteArray>,
    val headers: List<Pair<String, String>>,
    val method: String,
)

internal data class NetworkTransportResponse(
    val body: InputStream?,
    val headers: List<Pair<String, String>>,
    val status: Int,
    val statusText: String,
)

internal interface NetworkHttpConnection : Closeable {
    fun execute(request: NetworkTransportRequest, limits: AndroidNetworkLimits): NetworkTransportResponse
}

internal class PinnedHttp1Connection(
    target: NetworkConnectionTarget,
    private val timeoutMs: Int,
    private val socketFactory: NetworkSocketFactory,
    private val tlsLayer: NetworkTlsLayer,
) : NetworkHttpConnection {
    init {
        require(timeoutMs > 0)
    }

    private val target = target.copy(address = target.address.copyOf())
    private val closed = AtomicBoolean(false)
    private val executed = AtomicBoolean(false)
    private val timedOut = AtomicBoolean(false)
    private val lock = Any()
    private var activeSocket: Socket? = null
    private var watchdog: Thread? = null

    override fun execute(
        request: NetworkTransportRequest,
        limits: AndroidNetworkLimits,
    ): NetworkTransportResponse {
        check(executed.compareAndSet(false, true))
        if (closed.get()) throw SocketException("network connection closed")
        require(request.bodyLength in 0..limits.maxRequestBodyBytes.toLong())
        require(request.chunks.size <= MAX_HTTP_REQUEST_CHUNKS)
        require(request.chunks.all { it.size <= limits.maxChunkBytes })
        var measuredBody = 0L
        for (chunk in request.chunks) {
            require(chunk.size.toLong() <= Long.MAX_VALUE - measuredBody)
            measuredBody += chunk.size
        }
        require(measuredBody == request.bodyLength)
        require(request.headers.size <= limits.maxHeaders)
        val headerBytes = request.headers.fold(0L) { total, (name, value) ->
            total + name.toByteArray(Charsets.UTF_8).size + value.toByteArray(Charsets.UTF_8).size + 4L
        }
        require(headerBytes <= limits.maxHeaderBytes)
        startWatchdog()
        try {
            val rawSocket = socketFactory.create()
            activate(rawSocket)
            rawSocket.soTimeout = timeoutMs
            rawSocket.tcpNoDelay = true
            val address = InetAddress.getByAddress(target.address.copyOf())
            rawSocket.connect(InetSocketAddress(address, target.port), timeoutMs)
            val socket = if (target.scheme == "https") {
                tlsLayer.secure(
                    rawSocket,
                    NetworkTlsPolicy(
                        endpointIdentificationAlgorithm = "HTTPS",
                        hostname = target.host,
                        serverName = target.host.takeUnless(::isIpAddress),
                    ),
                    target.port,
                    timeoutMs,
                    ::activate,
                )
            } else {
                rawSocket
            }
            val output = BufferedOutputStream(socket.getOutputStream())
            writeHttp1Request(output, target, request)
            output.flush()
            val response = readHttp1Response(
                input = BufferedInputStream(TimeoutMappingInput(socket.getInputStream(), timedOut)),
                limits = limits,
                method = request.method,
                release = ::close,
            )
            return response.copy(body = response.body?.let { TimeoutMappingInput(it, timedOut) })
        } catch (error: Throwable) {
            close()
            if (timedOut.get() && error !is SocketTimeoutException) {
                throw SocketTimeoutException("network deadline exceeded").apply { initCause(error) }
            }
            throw error
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(lock) {
            runCatching { activeSocket?.close() }
            activeSocket = null
            watchdog?.interrupt()
            watchdog = null
        }
    }

    private fun activate(socket: Socket) {
        synchronized(lock) {
            if (closed.get()) {
                runCatching { socket.close() }
                throw SocketException("network connection closed")
            }
            activeSocket = socket
        }
    }

    private fun startWatchdog() {
        val timeoutNanos = timeoutMs.toLong() * 1_000_000L
        val started = System.nanoTime()
        val task = Thread({
            try {
                while (!closed.get()) {
                    val remaining = timeoutNanos - (System.nanoTime() - started)
                    if (remaining <= 0L) {
                        timedOut.set(true)
                        close()
                        return@Thread
                    }
                    val millis = remaining / 1_000_000L
                    val nanos = (remaining % 1_000_000L).toInt()
                    Thread.sleep(millis, nanos)
                }
            } catch (_: InterruptedException) {
                // Normal completion and explicit cancellation both interrupt the watchdog.
            }
        }, "holonomy-http-deadline").apply { isDaemon = true }
        synchronized(lock) {
            if (closed.get()) throw SocketException("network connection closed")
            watchdog = task
        }
        task.start()
    }

    private fun isIpAddress(value: String): Boolean = value.contains(':') || IPV4.matches(value)

    private companion object {
        val IPV4 = Regex("^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$")
    }
}

private class TimeoutMappingInput(
    private val source: InputStream,
    private val timedOut: AtomicBoolean,
) : InputStream() {
    override fun read(): Int = mapTimeout { source.read() }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        mapTimeout { source.read(buffer, offset, length) }

    override fun close() = source.close()

    private fun <T> mapTimeout(read: () -> T): T = try {
        read()
    } catch (error: IOException) {
        if (timedOut.get() && error !is SocketTimeoutException) {
            throw SocketTimeoutException("network deadline exceeded").apply { initCause(error) }
        }
        throw error
    }
}

internal object PlatformNetworkTlsLayer : NetworkTlsLayer {
    override fun secure(
        socket: Socket,
        policy: NetworkTlsPolicy,
        port: Int,
        timeoutMs: Int,
        activate: (Socket) -> Unit,
    ): Socket {
        val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
        val tlsSocket = factory.createSocket(socket, policy.hostname, port, true) as SSLSocket
        tlsSocket.soTimeout = timeoutMs
        val parameters = tlsSocket.sslParameters
        parameters.endpointIdentificationAlgorithm = policy.endpointIdentificationAlgorithm
        if (policy.serverName != null) parameters.serverNames = listOf(SNIHostName(policy.serverName))
        tlsSocket.sslParameters = parameters
        activate(tlsSocket)
        tlsSocket.startHandshake()
        return tlsSocket
    }
}
