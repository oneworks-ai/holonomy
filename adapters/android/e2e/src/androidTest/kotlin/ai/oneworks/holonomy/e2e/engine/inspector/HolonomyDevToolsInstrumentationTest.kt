package ai.oneworks.holonomy.e2e

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import android.os.SystemClock
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.v8.AdbInspectorOptions
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.EOFException
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HolonomyDevToolsInstrumentationTest {
    @Test
    fun waitForDebuggerAcceptsCdpAndResumesBootstrap() {
        val socketName = "holonomy_devtools_wait_test_${Process.myPid()}"
        val engine = RuntimeEngineFactory.create(
            assets = InstrumentationRegistry.getInstrumentation().targetContext.assets,
            nativeHost = FailClosedRuntimeNativeHost(),
            inspectorOptions = AdbInspectorOptions(
                socketName = socketName,
                waitForDebugger = true,
            ),
        )
        try {
            val startup = engine.start()
            TestWebSocket.connect(socketName).use { webSocket ->
                webSocket.sendText("{\"id\":1,\"method\":\"Runtime.enable\"}")
                assertTrue(webSocket.awaitResponse(1).has("result"))
                webSocket.sendText("{\"id\":2,\"method\":\"Runtime.runIfWaitingForDebugger\"}")
                assertTrue(webSocket.awaitResponse(2).has("result"))
                startup.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
                webSocket.sendText(
                    "{\"id\":3,\"method\":\"Runtime.evaluate\",\"params\":{" +
                        "\"expression\":\"6 * 7\",\"returnByValue\":true}}",
                )
                assertEquals(
                    42,
                    webSocket.awaitResponse(3)
                        .getJSONObject("result")
                        .getJSONObject("result")
                        .getInt("value"),
                )
            }
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Test
    fun exposesDiscoveryAndEvaluatesThroughRealCdpWebSocket() {
        val socketName = "holonomy_devtools_test_${Process.myPid()}"
        val engine = RuntimeEngineFactory.create(
            assets = InstrumentationRegistry.getInstrumentation().targetContext.assets,
            nativeHost = FailClosedRuntimeNativeHost(),
            inspectorOptions = AdbInspectorOptions(socketName = socketName),
        )
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertTrue(engine.capabilities.inspectorEnabled)

            val discovery = JSONObject(readDiscovery(socketName).getJSONObject(0).toString())
            assertEquals("holonomy-runtime", discovery.getString("id"))
            assertEquals("holonomy:///", discovery.getString("url"))
            assertTrue(discovery.getLong("holonomySession") >= 0L)
            assertTrue(discovery.getString("devtoolsFrontendUrl").contains("js_app.html?experiments=true&v8only=true"))
            assertTrue(discovery.getString("webSocketDebuggerUrl").contains("127.0.0.1:9229"))

            TestWebSocket.connect(socketName).use { webSocket ->
                webSocket.sendText("{\"id\":1,\"method\":\"Runtime.enable\"}")
                val context = webSocket.awaitRuntimeEnabled()
                val executionContext = context.getJSONObject("params").getJSONObject("context")
                assertEquals(1, executionContext.getInt("id"))
                assertFalse(executionContext.getString("origin").startsWith("app:"))
                TestWebSocket.connect(socketName).use { probe ->
                    probe.sendText(
                        "{\"id\":2,\"method\":\"Runtime.evaluate\",\"params\":{" +
                            "\"expression\":\"21 * 2\",\"returnByValue\":true}}",
                    )
                    val probeResponse = probe.awaitResponse(2)
                    assertTrue(probeResponse.toString(), probeResponse.has("result"))
                    assertEquals(42, probeResponse.getJSONObject("result").getJSONObject("result").getInt("value"))
                }
                webSocket.sendText(
                    "{\"id\":2,\"method\":\"Runtime.evaluate\",\"params\":{" +
                        "\"expression\":\"40 + 2\",\"returnByValue\":true}}",
                )
                val retainedResponse = webSocket.awaitResponse(2)
                assertEquals(
                    42,
                    retainedResponse.getJSONObject("result").getJSONObject("result").getInt("value"),
                )
            }
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    private fun readDiscovery(socketName: String): JSONArray = LocalSocket().use { socket ->
        socket.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
        socket.soTimeout = SOCKET_TIMEOUT_MS
        socket.outputStream.write(
            (
                "GET /json/list HTTP/1.1\r\n" +
                    "Host: 127.0.0.1:9229\r\n" +
                    "Connection: close\r\n\r\n"
            ).toByteArray(StandardCharsets.US_ASCII),
        )
        val response = socket.inputStream.readBytes().toString(StandardCharsets.UTF_8)
        assertTrue(response.startsWith("HTTP/1.1 200 OK"))
        JSONArray(response.substringAfter("\r\n\r\n"))
    }

    private class TestWebSocket private constructor(private val socket: LocalSocket) : Closeable {
        fun awaitResponse(id: Int): JSONObject {
            repeat(MAX_MESSAGES_PER_RESPONSE) {
                val message = JSONObject(readText())
                if (message.optInt("id", -1) == id) return message
            }
            error("The expected CDP response did not arrive")
        }

        fun awaitRuntimeEnabled(): JSONObject {
            var responseReceived = false
            var context: JSONObject? = null
            repeat(MAX_MESSAGES_PER_RESPONSE) {
                val message = JSONObject(readText())
                if (message.optInt("id", -1) == 1) responseReceived = true
                if (message.optString("method") == "Runtime.executionContextCreated") context = message
                if (responseReceived && context != null) return context
            }
            error("The Runtime.enable response and execution context did not both arrive")
        }

        override fun close() = socket.close()

        fun sendText(message: String) {
            val payload = message.toByteArray(StandardCharsets.UTF_8)
            val output = socket.outputStream
            output.write(0x81)
            when {
                payload.size < 126 -> output.write(0x80 or payload.size)
                payload.size <= 0xffff -> {
                    output.write(0x80 or 126)
                    output.write(payload.size ushr 8)
                    output.write(payload.size)
                }
                else -> error("The test CDP request is too large")
            }
            output.write(MASK)
            payload.forEachIndexed { index, byte ->
                output.write(byte.toInt() xor MASK[index % MASK.size].toInt())
            }
            output.flush()
        }

        private fun readText(): String {
            val input = socket.inputStream
            val first = readByte(input)
            assertTrue(first and 0x80 != 0)
            assertEquals(0x1, first and 0x0f)
            val second = readByte(input)
            assertEquals(0, second and 0x80)
            val length = when (val shortLength = second and 0x7f) {
                126 -> (readByte(input) shl 8) or readByte(input)
                127 -> {
                    var longLength = 0L
                    repeat(8) { longLength = (longLength shl 8) or readByte(input).toLong() }
                    require(longLength <= MAX_RESPONSE_BYTES)
                    longLength.toInt()
                }
                else -> shortLength
            }
            require(length <= MAX_RESPONSE_BYTES)
            return readExact(socket.inputStream, length).toString(StandardCharsets.UTF_8)
        }

        companion object {
            private val MASK = byteArrayOf(0x12, 0x34, 0x56, 0x78)

            fun connect(socketName: String): TestWebSocket {
                val deadline = SystemClock.elapsedRealtime() + SOCKET_TIMEOUT_MS
                while (true) {
                    val connected = runCatching { connectOnce(socketName) }
                    connected.getOrNull()?.let { return it }
                    if (SystemClock.elapsedRealtime() >= deadline) throw connected.exceptionOrNull()!!
                    SystemClock.sleep(CONNECT_RETRY_MS)
                }
            }

            private fun connectOnce(socketName: String): TestWebSocket {
                val socket = LocalSocket()
                return try {
                    socket.connect(LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT))
                    socket.soTimeout = SOCKET_TIMEOUT_MS
                    socket.outputStream.write(
                        (
                            "GET /devtools/page/holonomy-runtime HTTP/1.1\r\n" +
                                "Host: 127.0.0.1:9229\r\n" +
                                "Upgrade: websocket\r\n" +
                                "Connection: Upgrade\r\n" +
                                "Sec-WebSocket-Version: 13\r\n" +
                                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                        ).toByteArray(StandardCharsets.US_ASCII),
                    )
                    val headers = readHeaders(socket)
                    assertTrue(headers.startsWith("HTTP/1.1 101 Switching Protocols"))
                    TestWebSocket(socket)
                } catch (error: Throwable) {
                    socket.close()
                    throw error
                }
            }

            private fun readHeaders(socket: LocalSocket): String {
                val output = ByteArrayOutputStream()
                var matched = 0
                while (matched < 4 && output.size() < MAX_HEADER_BYTES) {
                    val byte = readByte(socket.inputStream)
                    output.write(byte)
                    matched = when {
                        matched == 0 && byte == '\r'.code -> 1
                        matched == 1 && byte == '\n'.code -> 2
                        matched == 2 && byte == '\r'.code -> 3
                        matched == 3 && byte == '\n'.code -> 4
                        byte == '\r'.code -> 1
                        else -> 0
                    }
                }
                require(matched == 4)
                return output.toString(StandardCharsets.US_ASCII.name())
            }
        }
    }

    private companion object {
        private const val MAX_HEADER_BYTES = 16 * 1024
        private const val MAX_MESSAGES_PER_RESPONSE = 32
        private const val MAX_RESPONSE_BYTES = 4 * 1024 * 1024
        private const val CONNECT_RETRY_MS = 25L
        private const val SOCKET_TIMEOUT_MS = 5_000
        private const val TIMEOUT_SECONDS = 20L

        private fun readByte(input: java.io.InputStream): Int = input.read().also {
            if (it < 0) throw EOFException("The CDP socket closed unexpectedly")
        }

        private fun readExact(input: java.io.InputStream, length: Int): ByteArray = ByteArray(length).also { output ->
            var offset = 0
            while (offset < output.size) {
                val read = input.read(output, offset, output.size - offset)
                if (read < 0) throw EOFException("The CDP socket closed unexpectedly")
                offset += read
            }
        }
    }
}
