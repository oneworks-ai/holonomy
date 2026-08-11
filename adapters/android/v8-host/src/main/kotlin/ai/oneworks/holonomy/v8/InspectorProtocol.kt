package ai.oneworks.holonomy.v8

import android.util.Base64
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.json.JSONObject

internal data class InspectorHttpRequest(
    val host: String,
    val path: String,
    val webSocketKey: String?,
)

internal object InspectorProtocol {
    private const val MAX_HTTP_HEADER_BYTES = 32 * 1024
    private const val WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    fun discoveryList(
        host: String,
        options: AdbInspectorOptions,
        sessionSequence: Long,
        v8Version: String,
    ): String {
        val socketUrl = webSocketUrl(host, options.targetId)
        return """
            [{
              "description":"Holonomy JavaScript runtime",
              "devtoolsFrontendUrl":"devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=${escapeJson(host)}/devtools/page/${escapeJson(options.targetId)}",
              "id":"${escapeJson(options.targetId)}",
              "holonomySession":$sessionSequence,
              "title":"${escapeJson(options.targetTitle)}",
              "type":"node",
              "url":"holonomy:///",
              "webSocketDebuggerUrl":"${escapeJson(socketUrl)}",
              "v8Version":"${escapeJson(v8Version)}"
            }]
        """.trimIndent()
    }

    fun discoveryVersion(host: String, options: AdbInspectorOptions, v8Version: String): String = """
        {
          "Browser":"Holonomy/${escapeJson(v8Version)}",
          "Protocol-Version":"1.3",
          "V8-Version":"${escapeJson(v8Version)}",
          "webSocketDebuggerUrl":"${escapeJson(webSocketUrl(host, options.targetId))}"
        }
    """.trimIndent()

    fun commandMethod(message: String): String? = runCatching {
        JSONObject(message).optString("method").takeIf(String::isNotEmpty)
    }.getOrNull()

    fun messageId(message: String): Long? = runCatching {
        val value = JSONObject(message)
        value.takeIf { it.has("id") }?.getLong("id")
    }.getOrNull()

    fun rewriteMessageId(message: String, id: Long): String = JSONObject(message)
        .put("id", id)
        .toString()

    fun executionContextCreated(options: AdbInspectorOptions): String = """
        {
          "method":"Runtime.executionContextCreated",
          "params":{"context":{
            "id":1,
            "origin":"holonomy://",
            "name":"${escapeJson(options.targetTitle)}",
            "auxData":{"isDefault":true,"type":"default"}
          }}
        }
    """.trimIndent()

    fun isExecutionContextCreated(message: String): Boolean =
        commandMethod(message) == "Runtime.executionContextCreated"

    fun messageSummary(message: String): String = runCatching {
        val value = JSONObject(message)
        val direction = when {
            value.has("method") && value.has("id") -> "request"
            value.has("method") -> "notification"
            else -> "response"
        }
        val id = if (value.has("id")) " id=${value.optLong("id")}" else ""
        val method = value.optString("method").takeIf(String::isNotEmpty)?.let { " method=$it" } ?: ""
        val error = if (value.has("error")) " error=true" else ""
        "$direction$id$method$error"
    }.getOrDefault("malformed")

    fun httpResponse(status: String, contentType: String, body: String): ByteArray {
        val payload = body.toByteArray(StandardCharsets.UTF_8)
        val headers = buildString {
            append("HTTP/1.1 ").append(status).append("\r\n")
            append("Content-Type: ").append(contentType).append("\r\n")
            append("Content-Length: ").append(payload.size).append("\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(StandardCharsets.US_ASCII)
        return headers + payload
    }

    fun readRequest(input: InputStream): InspectorHttpRequest {
        val bytes = ArrayList<Byte>()
        var matched = 0
        while (bytes.size < MAX_HTTP_HEADER_BYTES) {
            val next = input.read()
            require(next >= 0) { "The DevTools client closed before sending a request" }
            bytes.add(next.toByte())
            matched = when {
                matched == 0 && next == '\r'.code -> 1
                matched == 1 && next == '\n'.code -> 2
                matched == 2 && next == '\r'.code -> 3
                matched == 3 && next == '\n'.code -> 4
                next == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) break
        }
        require(matched == 4) { "The DevTools HTTP request headers are too large" }

        val request = bytes.toByteArray().toString(StandardCharsets.US_ASCII)
        val lines = request.split("\r\n")
        val requestLine = lines.firstOrNull()?.split(' ') ?: emptyList()
        require(requestLine.size == 3 && requestLine[0] == "GET") { "Only DevTools GET requests are supported" }
        val headers = mutableMapOf<String, String>()
        for (line in lines.drop(1)) {
            if (line.isEmpty()) break
            val separator = line.indexOf(':')
            require(separator > 0) { "The DevTools request contains a malformed header" }
            headers[line.substring(0, separator).lowercase()] = line.substring(separator + 1).trim()
        }
        val host = headers["host"]?.takeIf(::isSafeHost) ?: "127.0.0.1"
        return InspectorHttpRequest(
            host = host,
            path = requestLine[1].substringBefore('?'),
            webSocketKey = headers["sec-websocket-key"],
        )
    }

    fun switchingProtocols(webSocketKey: String): ByteArray {
        require(webSocketKey.length in 16..128) { "The WebSocket key is invalid" }
        val digest = MessageDigest.getInstance("SHA-1")
            .digest((webSocketKey + WEB_SOCKET_GUID).toByteArray(StandardCharsets.US_ASCII))
        val accept = Base64.encodeToString(digest, Base64.NO_WRAP)
        return (
            "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: $accept\r\n\r\n"
        ).toByteArray(StandardCharsets.US_ASCII)
    }

    private fun escapeJson(value: String): String = buildString(value.length + 8) {
        for (character in value) {
            when (character) {
                '\\' -> append("\\\\")
                '"' -> append("\\\"")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) {
                    append("\\u").append(character.code.toString(16).padStart(4, '0'))
                } else {
                    append(character)
                }
            }
        }
    }

    private fun isSafeHost(host: String): Boolean =
        host.length in 1..128 && host.all { it.isLetterOrDigit() || it in ".:-[]" }

    private fun webSocketUrl(host: String, targetId: String): String =
        "ws://$host/devtools/page/$targetId"
}
