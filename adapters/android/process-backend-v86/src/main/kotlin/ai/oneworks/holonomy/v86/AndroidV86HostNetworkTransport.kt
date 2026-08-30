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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

fun interface AndroidV86NetworkAddressResolver {
    fun resolve(hostname: String): List<InetAddress>
}

/** Host socket implementation used only after the Runtime Kernel authorizes one canonical endpoint. */
class AndroidV86HostNetworkTransport(
    private val connectTimeoutMs: Int = 30_000,
    private val maxSockets: Int = 32,
    private val addressResolver: AndroidV86NetworkAddressResolver = AndroidV86NetworkAddressResolver { hostname ->
        InetAddress.getAllByName(hostname).toList()
    },
) : AndroidV86NetworkTransport {
    private val closed = AtomicBoolean(false)
    private val handles = ConcurrentHashMap<Long, Resource>()
    private val nextHandle = AtomicLong(1)
    private val readers = Executors.newCachedThreadPool { task -> Thread(task, "holonomy-v86-socket-reader") }

    override fun execute(request: JSONObject, authorizationTerminal: JSONObject): JSONObject = runCatching {
        requireAuthorized(authorizationTerminal)
        val connection = URL(request.getString("url")).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = connectTimeoutMs
            connection.instanceFollowRedirects = false
            connection.requestMethod = request.optString("method", "GET")
            request.optJSONArray("headers")?.objects()?.forEach { pair ->
                require(pair.length() == 2)
                connection.addRequestProperty(pair.getString(0), pair.getString(1))
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
    }.getOrElse { AndroidV86NetworkTransport.failure("provider.unavailable") }

    override fun open(
        request: JSONObject,
        authorizationTerminal: JSONObject,
        sink: AndroidV86NetworkEventSink,
    ): JSONObject = runCatching {
        requireAuthorized(authorizationTerminal)
        check(!closed.get() && handles.size < maxSockets)
        val hostname = request.getString("hostname")
        val port = request.getInt("port")
        require(hostname.length in 1..253 && port in 1..65_535)
        val addresses = addresses(hostname)
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
        readers.execute { read(resource) }
        AndroidV86NetworkTransport.success(JSONObject().put("handleId", id))
    }.getOrElse { AndroidV86NetworkTransport.failure("provider.unavailable") }

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
    }.getOrElse { AndroidV86NetworkTransport.failure("provider.unavailable") }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        handles.values.toSet().forEach { resource -> closeResource(resource, emit = false) }
        handles.clear()
        readers.shutdownNow()
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
        if (emit && !closed.get()) emit(resource, "close")
    }

    private fun requireAuthorized(terminal: JSONObject) {
        require(terminal.optBoolean("ok"))
    }

    private fun addresses(hostname: String): List<InetAddress> {
        val resolved = addressResolver.resolve(hostname)
        require(resolved.isNotEmpty() && resolved.size <= MAX_RESOLVED_ADDRESSES)
        return resolved
            .distinctBy { address -> address.address.toList() }
            .sortedWith(compareBy<InetAddress>({ address -> address.address.size }, { address -> address.hostAddress }))
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
        private const val MAX_RESOLVED_ADDRESSES = 64
        private const val MAX_UDP_BYTES = 1472
        private const val UDP_READ_TIMEOUT_MS = 1_000

        private fun JSONArray.objects(): List<JSONArray> =
            (0 until length()).map { index -> getJSONArray(index) }

        private fun JSONArray.bytes(maximum: Int): ByteArray {
            require(length() <= maximum)
            return ByteArray(length()) { index -> getInt(index).also { require(it in 0..255) }.toByte() }
        }

        private fun ByteArray.jsonBytes(): JSONArray = JSONArray().also { output ->
            forEach { byte -> output.put(byte.toInt() and 0xFF) }
        }

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
