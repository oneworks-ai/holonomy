package ai.oneworks.holonomy.e2e

import java.io.BufferedInputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/** E2E-only authorized Host transport for the real v86 Linux network probe. */
internal class V86TrustedBackendNetworkProbe : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val failure = AtomicReference<Throwable?>()
    private val server = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), E2E_PROCESS_NETWORK_PORT))
    }
    private val worker = Thread({ serve() }, "holonomy-v86-http").apply {
        isDaemon = true
        start()
    }

    fun authorizedTerminal(request: JSONObject, authorization: String): String {
        val terminal = JSONObject(authorization)
        if (!terminal.optBoolean("ok")) return authorization
        val receipt = terminal.getJSONObject("result").getJSONObject("value")
        check(receipt.getBoolean("authorized")) { "Process network authorization was not granted" }
        return JSONObject()
            .put("ok", true)
            .put("result", JSONObject().put("kind", "value").put("value", fetch(request)))
            .toString()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        server.close()
        worker.join(NETWORK_TIMEOUT_MS.toLong())
        failure.get()?.let { throw it }
    }

    private fun fetch(request: JSONObject): JSONObject {
        val uri = URI(request.getString("url"))
        check(
            uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == E2E_PROCESS_NETWORK_PORT &&
                request.getString("method") == "GET",
        ) { "Unexpected process network request" }
        val response = Socket().use { socket ->
            socket.connect(InetSocketAddress(uri.host, uri.port), NETWORK_TIMEOUT_MS)
            socket.soTimeout = NETWORK_TIMEOUT_MS
            val output = socket.getOutputStream().bufferedWriter(Charsets.US_ASCII)
            output.write("GET ${uri.rawPath.ifEmpty { "/" }} HTTP/1.1\r\n")
            output.write("Host: ${uri.host}:${uri.port}\r\n")
            output.write("Connection: close\r\n\r\n")
            output.flush()
            socket.getInputStream().readBytes()
        }
        val separator = "\r\n\r\n".toByteArray(Charsets.US_ASCII)
        val boundary = response.indexOf(separator)
        check(boundary >= 0) { "Invalid process network response" }
        val head = response.copyOfRange(0, boundary).toString(Charsets.US_ASCII).split("\r\n")
        val status = head.first().split(' ', limit = 3)
        val headers = JSONArray()
        head.drop(1).forEach { line ->
            val index = line.indexOf(':')
            check(index > 0) { "Invalid process network response header" }
            headers.put(JSONArray().put(line.substring(0, index).lowercase()).put(line.substring(index + 1).trim()))
        }
        return JSONObject()
            .put("bodyBytes", JSONArray(response.copyOfRange(boundary + separator.size, response.size).map(Byte::toInt)))
            .put("headers", headers)
            .put("redirected", false)
            .put("status", status[1].toInt())
            .put("statusText", status.getOrElse(2) { "" })
            .put("url", uri.toString())
    }

    private fun serve() {
        runCatching {
            server.accept().use { client ->
                client.soTimeout = NETWORK_TIMEOUT_MS
                val input = BufferedInputStream(client.getInputStream())
                val request = ByteArray(4_096)
                val count = input.read(request)
                check(count > 0 && request.copyOf(count).toString(Charsets.US_ASCII).startsWith("GET /v86 "))
                val body = "HOLO_ANDROID_V86_NETWORK_OK"
                client.getOutputStream().bufferedWriter(Charsets.US_ASCII).use { output ->
                    output.write("HTTP/1.1 200 OK\r\n")
                    output.write("Content-Type: text/plain\r\n")
                    output.write("Content-Length: ${body.length}\r\n")
                    output.write("Connection: close\r\n\r\n")
                    output.write(body)
                    output.flush()
                }
            }
        }.onFailure { error -> if (!closed.get()) failure.set(error) }
    }

    private fun ByteArray.indexOf(needle: ByteArray): Int {
        for (index in 0..size - needle.size) {
            if (needle.indices.all { offset -> this[index + offset] == needle[offset] }) return index
        }
        return -1
    }

    private companion object {
        private const val NETWORK_TIMEOUT_MS = 10_000
    }
}
