package ai.oneworks.holonomy.v86

import java.io.ByteArrayOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

fun interface AndroidV86NetworkAddressResolver {
    fun resolve(hostname: String): List<InetAddress>
}

/** Host socket implementation used only after the Runtime Kernel authorizes one canonical endpoint. */
class AndroidV86HostNetworkTransport(
    private val allowPrivateNetwork: Boolean = false,
    private val connectTimeoutMs: Int = 30_000,
    private val maxSockets: Int = 32,
    private val addressResolver: AndroidV86NetworkAddressResolver = AndroidV86NetworkAddressResolver { hostname ->
        InetAddress.getAllByName(hostname).toList()
    },
    private val diagnostic: (String) -> Unit = {},
) : AndroidV86NetworkTransport {
    private val closed = AtomicBoolean(false)
    private val handles = ConcurrentHashMap<Long, Resource>()
    private val nextHandle = AtomicLong(1)
    private val readers = Executors.newCachedThreadPool { task -> Thread(task, "holonomy-v86-socket-reader") }
    private val socketPermits = Semaphore(maxSockets, true)

    init {
        require(maxSockets in 1..256)
    }

    override fun execute(request: JSONObject, authorizationTerminal: JSONObject): JSONObject = runCatching {
        val admittedAddresses = admittedAddresses(authorizationTerminal)
        check(socketPermits.tryAcquire())
        try {
            val url = URL(request.getString("url"))
            require(isIpLiteral(url.host) && admittedAddresses.any { address -> address.hostAddress == url.host })
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = connectTimeoutMs
                connection.instanceFollowRedirects = false
                val method = request.optString("method", "GET").uppercase()
                require(method in HTTP_METHODS)
                connection.requestMethod = method
                request.optJSONArray("headers")?.objects()?.forEach { pair ->
                    require(pair.length() == 2)
                    connection.addRequestProperty(pair.getString(0), pair.getString(1))
                }
                val requestBody = request.optJSONArray("bodyBytes")?.bytes(MAX_HTTP_REQUEST_BODY_BYTES)
                    ?: ByteArray(0)
                if (requestBody.isNotEmpty()) {
                    require(method !in setOf("GET", "HEAD"))
                    connection.doOutput = true
                    connection.setFixedLengthStreamingMode(requestBody.size)
                    connection.outputStream.use { output -> output.write(requestBody) }
                }
                val status = connection.responseCode
                val body = boundedRead(
                    if (status >= 400) connection.errorStream else connection.inputStream,
                    MAX_HTTP_BODY_BYTES,
                )
                AndroidV86NetworkTransport.success(
                    JSONObject()
                        .put("bodyBytes", body.jsonBytes())
                        .put("headers", headers(connection))
                        .put("redirected", false)
                        .put("status", status)
                        .put("statusText", connection.responseMessage ?: "")
                        .put("url", connection.url.toString()),
                )
            } finally {
                connection.disconnect()
            }
        } finally {
            socketPermits.release()
        }
    }.getOrElse { error ->
        diagnostic("http execute failed: ${error.javaClass.name}: ${error.message.orEmpty()}")
        AndroidV86NetworkTransport.failure("provider.unavailable")
    }

    override fun open(
        request: JSONObject,
        authorizationTerminal: JSONObject,
        sink: AndroidV86NetworkEventSink,
    ): JSONObject = runCatching {
        val addresses = admittedAddresses(authorizationTerminal)
        check(!closed.get() && socketPermits.tryAcquire())
        var permitOwned = true
        try {
            val hostname = request.getString("hostname")
            val port = request.getInt("port")
            require(hostname.length in 1..253 && port in 1..65_535)
            val id = nextHandle.getAndIncrement()
            val resource = when (request.getString("transport")) {
                "tcp" -> TcpResource(id, connectTcp(addresses, port), sink)
                "udp" -> UdpResource(id, DatagramSocket().also { socket ->
                    socket.connect(InetSocketAddress(addresses.first(), port))
                    socket.soTimeout = UDP_READ_TIMEOUT_MS
                }, sink)
                else -> error("Unsupported process network transport")
            }
            check(handles.putIfAbsent(id, resource) == null)
            permitOwned = false
            try {
                readers.execute { read(resource) }
            } catch (error: Throwable) {
                closeResource(resource, emit = false)
                throw error
            }
            AndroidV86NetworkTransport.success(JSONObject().put("handleId", id))
        } finally {
            if (permitOwned) socketPermits.release()
        }
    }.getOrElse { error ->
        diagnostic("socket open failed: ${error.javaClass.name}: ${error.message.orEmpty()}")
        AndroidV86NetworkTransport.failure("provider.unavailable")
    }

    override fun control(request: JSONObject): JSONObject = runCatching {
        val id = request.getLong("handleId")
        val resource = requireNotNull(handles[id])
        when (request.getString("operation")) {
            "tcpWrite" -> {
                require(resource is TcpResource)
                val bytes = request.getJSONArray("bytes").bytes(MAX_CONTROL_BYTES)
                synchronized(resource.socket) {
                    resource.socket.getOutputStream().write(bytes)
                    resource.socket.getOutputStream().flush()
                }
            }
            "tcpEnd" -> {
                require(resource is TcpResource)
                resource.socket.shutdownOutput()
            }
            "udpSend" -> {
                require(resource is UdpResource)
                val bytes = request.getJSONArray("bytes").bytes(MAX_UDP_BYTES)
                resource.socket.send(DatagramPacket(bytes, bytes.size))
            }
            "close" -> closeResource(resource, emit = false)
            else -> error("Unsupported process network control")
        }
        AndroidV86NetworkTransport.success()
    }.getOrElse { error ->
        diagnostic("socket control failed: ${error.javaClass.name}: ${error.message.orEmpty()}")
        AndroidV86NetworkTransport.failure("provider.unavailable")
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        handles.values.toSet().forEach { resource -> closeResource(resource, emit = false) }
        handles.clear()
        readers.shutdownNow()
    }

    override fun resolve(hostname: String): List<String> = addresses(hostname).map { address ->
        requireNotNull(address.hostAddress)
    }

    private fun read(resource: Resource) {
        try {
            when (resource) {
                is TcpResource -> readTcp(resource)
                is UdpResource -> readUdp(resource)
            }
        } catch (_: Throwable) {
            if (!resource.closed.get()) emit(resource, "error")
        } finally {
            closeResource(resource, emit = true)
        }
    }

    private fun readTcp(resource: TcpResource) {
        val input = resource.socket.getInputStream()
        val buffer = ByteArray(16 * 1024)
        while (!closed.get() && !resource.closed.get()) {
            val count = input.read(buffer)
            if (count < 0) {
                emit(resource, "end")
                return
            }
            if (count > 0) emit(resource, "data", buffer.copyOf(count))
        }
    }

    private fun readUdp(resource: UdpResource) {
        val bytes = ByteArray(MAX_UDP_BYTES)
        while (!closed.get() && !resource.closed.get()) {
            val packet = DatagramPacket(bytes, bytes.size)
            try {
                resource.socket.receive(packet)
                emit(resource, "data", packet.data.copyOfRange(packet.offset, packet.offset + packet.length))
            } catch (error: java.net.SocketTimeoutException) {
                continue
            }
        }
    }

    private fun emit(resource: Resource, event: String, bytes: ByteArray? = null) {
        resource.sink.emit(
            JSONObject()
                .put("event", event)
                .put("handleId", resource.id)
                .put("transport", resource.transport)
                .apply { if (bytes != null) put("bytes", bytes.jsonBytes()) },
        )
    }

    private fun closeResource(resource: Resource, emit: Boolean) {
        if (!resource.closed.compareAndSet(false, true)) return
        handles.remove(resource.id, resource)
        runCatching { resource.close() }
        socketPermits.release()
        if (emit && !closed.get()) emit(resource, "close")
    }

    private fun requireAuthorized(terminal: JSONObject) {
        require(terminal.getBoolean("ok"))
    }

    private fun admittedAddresses(terminal: JSONObject): List<InetAddress> {
        requireAuthorized(terminal)
        val result = terminal.getJSONObject("result")
        require(result.getString("kind") == "value")
        val receipt = result.getJSONObject("value")
        require(receipt.getBoolean("authorized"))
        val values = receipt.getJSONObject("resolution").getJSONArray("addresses")
        require(values.length() in 1..MAX_RESOLVED_ADDRESSES)
        return (0 until values.length()).map { index ->
            val value = values.getString(index)
            require(isIpLiteral(value))
            InetAddress.getByName(value)
        }.distinctBy { address -> address.address.toList() }.also { addresses ->
            require(addresses.size == values.length())
        }
    }

    private fun addresses(hostname: String): List<InetAddress> {
        val resolved = addressResolver.resolve(hostname)
        require(resolved.isNotEmpty() && resolved.size <= MAX_RESOLVED_ADDRESSES)
        val addresses = resolved
            .distinctBy { address -> address.address.toList() }
            .sortedWith(compareBy<InetAddress>({ address -> address.address.size }, { address -> address.hostAddress }))
        if (!allowPrivateNetwork && !isIpLiteral(hostname)) require(addresses.all(::isPublicAddress))
        return addresses
    }

    private fun isIpLiteral(value: String): Boolean =
        value.contains(':') || value.split('.').let { parts ->
            parts.size == 4 && parts.all { part -> part.toIntOrNull()?.let { it in 0..255 } == true }
        }

    private fun isPublicAddress(value: InetAddress): Boolean {
        if (
            value.isAnyLocalAddress || value.isLoopbackAddress || value.isLinkLocalAddress ||
            value.isSiteLocalAddress || value.isMulticastAddress
        ) return false
        val bytes = value.address.map { byte -> byte.toInt() and 0xFF }
        if (bytes.size == 4) {
            val address = bytes.fold(0L) { output, byte -> (output shl 8) or byte.toLong() }
            return NON_PUBLIC_IPV4.none { (base, bits) ->
                val mask = if (bits == 0) 0L else (0xFFFF_FFFFL shl (32 - bits)) and 0xFFFF_FFFFL
                (address and mask) == (base and mask)
            }
        }
        if (bytes.size != 16 || bytes[0] and 0xE0 != 0x20) return false
        return NON_PUBLIC_IPV6.none { (prefix, bits) -> matchesPrefix(bytes, prefix, bits) }
    }

    private fun matchesPrefix(address: List<Int>, prefix: List<Int>, bits: Int): Boolean {
        val whole = bits / 8
        if ((0 until whole).any { index -> address[index] != prefix[index] }) return false
        val remaining = bits % 8
        if (remaining == 0) return true
        val mask = 0xFF shl (8 - remaining) and 0xFF
        return (address[whole] and mask) == (prefix[whole] and mask)
    }

    private fun connectTcp(addresses: List<InetAddress>, port: Int): Socket {
        var failure: Throwable? = null
        for (address in addresses) {
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(address, port), connectTimeoutMs)
                socket.tcpNoDelay = true
                return socket
            } catch (error: Throwable) {
                failure = error
                runCatching(socket::close)
            }
        }
        throw requireNotNull(failure)
    }

    private sealed class Resource(
        val id: Long,
        val sink: AndroidV86NetworkEventSink,
        val transport: String,
    ) {
        val closed = AtomicBoolean(false)
        abstract fun close()
    }

    private class TcpResource(
        id: Long,
        val socket: Socket,
        sink: AndroidV86NetworkEventSink,
    ) : Resource(id, sink, "tcp") {
        override fun close() = socket.close()
    }

    private class UdpResource(
        id: Long,
        val socket: DatagramSocket,
        sink: AndroidV86NetworkEventSink,
    ) : Resource(id, sink, "udp") {
        override fun close() = socket.close()
    }

    private companion object {
        private const val MAX_CONTROL_BYTES = 64 * 1024
        private const val MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024
        private const val MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024
        private const val MAX_RESOLVED_ADDRESSES = 64
        private const val MAX_UDP_BYTES = 1472
        private const val UDP_READ_TIMEOUT_MS = 1_000
        private val NON_PUBLIC_IPV4 = listOf(
            0x00000000L to 8,
            0x0A000000L to 8,
            0x64400000L to 10,
            0x7F000000L to 8,
            0xA9FE0000L to 16,
            0xAC100000L to 12,
            0xC0000000L to 24,
            0xC0000200L to 24,
            0xC0586300L to 24,
            0xC0A80000L to 16,
            0xC6120000L to 15,
            0xC6336400L to 24,
            0xCB007100L to 24,
            0xE0000000L to 4,
            0xF0000000L to 4,
        )
        private val NON_PUBLIC_IPV6 = listOf(
            ipv6Prefix("00000000000000000000000000000000", 128),
            ipv6Prefix("00000000000000000000000000000001", 128),
            ipv6Prefix("00000000000000000000ffff00000000", 96),
            ipv6Prefix("0064ff9b000000000000000000000000", 96),
            ipv6Prefix("0064ff9b000100000000000000000000", 48),
            ipv6Prefix("01000000000000000000000000000000", 64),
            ipv6Prefix("01000000000000010000000000000000", 64),
            ipv6Prefix("20010000000000000000000000000000", 23),
            ipv6Prefix("20010db8000000000000000000000000", 32),
            ipv6Prefix("20020000000000000000000000000000", 16),
            ipv6Prefix("3fff0000000000000000000000000000", 20),
            ipv6Prefix("5f000000000000000000000000000000", 16),
            ipv6Prefix("fc000000000000000000000000000000", 7),
            ipv6Prefix("fe800000000000000000000000000000", 10),
            ipv6Prefix("ff000000000000000000000000000000", 8),
        )
        private val HTTP_METHODS = setOf("DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT")

        private fun JSONArray.objects(): List<JSONArray> =
            (0 until length()).map { index -> getJSONArray(index) }

        private fun JSONArray.bytes(maximum: Int): ByteArray {
            require(length() <= maximum)
            return ByteArray(length()) { index -> getInt(index).also { require(it in 0..255) }.toByte() }
        }

        private fun ByteArray.jsonBytes(): JSONArray = JSONArray().also { output ->
            forEach { byte -> output.put(byte.toInt() and 0xFF) }
        }

        private fun ipv6Prefix(hex: String, bits: Int): Pair<List<Int>, Int> =
            hex.chunked(2).map { value -> value.toInt(16) } to bits

        private fun boundedRead(input: java.io.InputStream?, maximum: Int): ByteArray {
            if (input == null) return ByteArray(0)
            input.use { source ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val count = source.read(buffer)
                    if (count < 0) return output.toByteArray()
                    require(output.size() + count <= maximum)
                    output.write(buffer, 0, count)
                }
            }
        }

        private fun headers(connection: HttpURLConnection): JSONArray = JSONArray().also { output ->
            connection.headerFields.entries
                .filter { (name, _) -> name != null }
                .sortedBy { (name, _) -> name.lowercase() }
                .forEach { (name, values) -> values.forEach { value -> output.put(JSONArray().put(name).put(value)) } }
        }
    }
}
