package ai.oneworks.holonomy.network

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import kotlin.math.min

internal fun writeHttp1Request(
    output: OutputStream,
    target: NetworkConnectionTarget,
    request: NetworkTransportRequest,
) {
    require(target.requestTarget.startsWith('/') && target.requestTarget.all(::isVisibleAscii))
    require(HTTP_TOKEN.matches(request.method))
    var measuredBody = 0L
    for (chunk in request.chunks) {
        require(chunk.size.toLong() <= Long.MAX_VALUE - measuredBody)
        measuredBody += chunk.size
    }
    require(measuredBody == request.bodyLength)
    writeHttpLine(output, "${request.method} ${target.requestTarget} HTTP/1.1")
    writeHttpLine(output, "host: ${target.hostHeader}")
    writeHttpLine(output, "accept-encoding: identity")
    writeHttpLine(output, "connection: close")
    writeHttpLine(output, "content-length: ${request.bodyLength}")
    val names = HashSet<String>()
    for ((name, value) in request.headers) {
        require(name == name.lowercase() && HTTP_TOKEN.matches(name))
        require(name !in HTTP_MANAGED_REQUEST_HEADERS && names.add(name))
        require(value.all(::isHeaderByte) && !hasInvalidHttpText(value))
        writeHttpLine(output, "$name: $value")
    }
    writeHttpLine(output, "")
    for (chunk in request.chunks) output.write(chunk)
}

internal fun readHttp1Response(
    input: InputStream,
    limits: AndroidNetworkLimits,
    method: String,
    release: () -> Unit,
): NetworkTransportResponse {
    val lines = StrictHttpLineReader(input)
    val budget = HeaderBudget(limits.maxHeaders, limits.maxHeaderBytes)
    var informational = 0
    while (true) {
        val head = readResponseHead(lines, budget, limits.maxHeaderBytes)
        val framing = readResponseFraming(head.headers)
        if (head.status !in 100..199) {
            val noBody = method == "HEAD" || head.status == 204 || head.status == 205 || head.status == 304
            if (!noBody && framing.contentLength != null && framing.contentLength > limits.maxResponseBodyBytes) {
                throw HttpResponseLimitExceeded()
            }
            val body = when {
                noBody || framing.contentLength == 0L -> null
                framing.chunked -> ChunkedBodyInput(input, lines, limits, budget, release)
                framing.contentLength != null -> ExactBodyInput(input, framing.contentLength, release)
                else -> EofBodyInput(input, limits.maxResponseBodyBytes.toLong(), release)
            }
            if (body == null) release()
            return NetworkTransportResponse(body, head.headers, head.status, head.statusText)
        }
        informational += 1
        if (
            informational > MAX_INFORMATIONAL_RESPONSES || head.status == 101 || framing.chunked ||
            (framing.contentLength != null && framing.contentLength != 0L)
        ) throw HttpProtocolException("invalid informational response")
    }
}

internal class HttpResponseLimitExceeded : IOException()

internal class HttpProtocolException(message: String) : IOException(message)

private data class HttpResponseHead(
    val headers: List<Pair<String, String>>,
    val status: Int,
    val statusText: String,
)

private data class ResponseFraming(
    val chunked: Boolean,
    val contentLength: Long?,
)

private fun readResponseHead(
    lines: StrictHttpLineReader,
    budget: HeaderBudget,
    maxLineBytes: Int,
): HttpResponseHead {
    val statusLine = lines.read(maxLineBytes)
    budget.consumeBytes(statusLine.size + 2)
    val statusMatch = STATUS_LINE.matchEntire(statusLine.toLatin1())
        ?: throw HttpProtocolException("invalid status line")
    val status = statusMatch.groupValues[1].toInt()
    requireProtocol(status in 100..599)
    val statusText = statusMatch.groupValues[2]
    requireProtocol(!hasInvalidHttpText(statusText))
    val headers = mutableListOf<Pair<String, String>>()
    while (true) {
        val raw = lines.read(maxLineBytes)
        budget.consumeBytes(raw.size + 2)
        if (raw.isEmpty()) break
        requireProtocol(raw[0] != SPACE && raw[0] != TAB)
        val separator = raw.indexOf(COLON)
        requireProtocol(separator > 0)
        val name = raw.copyOfRange(0, separator).toLatin1()
        requireProtocol(HTTP_TOKEN.matches(name))
        val value = raw.copyOfRange(separator + 1, raw.size).toLatin1().trimHttpWhitespace()
        requireProtocol(!hasInvalidHttpText(value))
        budget.consumeHeader()
        headers += name.lowercase() to value
    }
    return HttpResponseHead(headers, status, statusText)
}

private fun readResponseFraming(headers: List<Pair<String, String>>): ResponseFraming {
    var contentLength: Long? = null
    val transferEncoding = mutableListOf<String>()
    for ((name, value) in headers) {
        if (name == "content-encoding") requireProtocol(value.trimHttpWhitespace().equals("identity", ignoreCase = true))
        if (name == "content-length") {
            val values = value.split(',')
            requireProtocol(values.isNotEmpty())
            for (item in values) {
                val normalized = item.trimHttpWhitespace()
                requireProtocol(DECIMAL.matches(normalized))
                val parsed = normalized.toLongOrNull() ?: throw HttpResponseLimitExceeded()
                if (contentLength == null) contentLength = parsed else requireProtocol(contentLength == parsed)
            }
        }
        if (name == "transfer-encoding") {
            transferEncoding += value.split(',').map { it.trimHttpWhitespace().lowercase() }
        }
    }
    requireProtocol(contentLength == null || transferEncoding.isEmpty())
    if (transferEncoding.isNotEmpty()) requireProtocol(transferEncoding == listOf("chunked"))
    return ResponseFraming(chunked = transferEncoding.isNotEmpty(), contentLength = contentLength)
}

private class StrictHttpLineReader(
    private val input: InputStream,
) {
    fun read(maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream(min(maxBytes, 256))
        while (true) {
            val value = input.read()
            if (value < 0) throw HttpProtocolException("unexpected EOF")
            if (value == CR.toInt()) {
                if (input.read() != LF.toInt()) throw HttpProtocolException("invalid line ending")
                return output.toByteArray()
            }
            if (value == LF.toInt()) throw HttpProtocolException("bare LF")
            if (output.size() >= maxBytes) throw HttpResponseLimitExceeded()
            output.write(value)
        }
    }
}

private class HeaderBudget(
    private val maxCount: Int,
    private val maxBytes: Int,
) {
    private var bytes = 0L
    private var count = 0

    fun consumeBytes(value: Int) {
        bytes += value
        if (bytes > maxBytes) throw HttpResponseLimitExceeded()
    }

    fun consumeHeader() {
        count += 1
        if (count > maxCount) throw HttpResponseLimitExceeded()
    }
}

private abstract class ReleasingBodyInput(
    protected val source: InputStream,
    private val release: () -> Unit,
) : InputStream() {
    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)

    protected fun finish() {
        if (closed.compareAndSet(false, true)) release()
    }

    protected fun fail(error: IOException): Nothing {
        finish()
        throw error
    }

    override fun close() = finish()

    override fun read(): Int {
        val single = ByteArray(1)
        return if (read(single, 0, 1) < 0) -1 else single[0].toInt() and 0xFF
    }

    protected fun validateRange(buffer: ByteArray, offset: Int, length: Int) {
        if (offset < 0 || length < 0 || offset > buffer.size - length) throw IndexOutOfBoundsException()
    }
}

private class ExactBodyInput(
    source: InputStream,
    length: Long,
    release: () -> Unit,
) : ReleasingBodyInput(source, release) {
    private var remaining = length

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        validateRange(buffer, offset, length)
        if (length == 0) return 0
        if (remaining == 0L) {
            finish()
            return -1
        }
        val read = try {
            source.read(buffer, offset, min(length.toLong(), remaining).toInt())
        } catch (error: IOException) {
            fail(error)
        }
        if (read <= 0) fail(HttpProtocolException("truncated content-length body"))
        remaining -= read
        if (remaining == 0L) finish()
        return read
    }
}

private class EofBodyInput(
    source: InputStream,
    private val maximum: Long,
    release: () -> Unit,
) : ReleasingBodyInput(source, release) {
    private var total = 0L

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        validateRange(buffer, offset, length)
        if (length == 0) return 0
        if (total == maximum) {
            val extra = try {
                source.read()
            } catch (error: IOException) {
                fail(error)
            }
            if (extra < 0) {
                finish()
                return -1
            }
            fail(HttpResponseLimitExceeded())
        }
        val read = try {
            source.read(buffer, offset, min(length.toLong(), maximum - total).toInt())
        } catch (error: IOException) {
            fail(error)
        }
        if (read < 0) {
            finish()
            return -1
        }
        if (read == 0) fail(HttpProtocolException("empty body read"))
        total += read
        return read
    }
}

private class ChunkedBodyInput(
    source: InputStream,
    private val lines: StrictHttpLineReader,
    private val limits: AndroidNetworkLimits,
    private val headerBudget: HeaderBudget,
    release: () -> Unit,
) : ReleasingBodyInput(source, release) {
    private var chunkCount = 0
    private var framingBytes = 0L
    private var needsTerminator = false
    private var remaining = 0L
    private var total = 0L

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        validateRange(buffer, offset, length)
        if (length == 0) return 0
        try {
            if (remaining == 0L) beginChunk()
            if (remaining < 0L) return -1
            val read = source.read(buffer, offset, min(length.toLong(), remaining).toInt())
            if (read <= 0) fail(HttpProtocolException("truncated chunk"))
            remaining -= read
            total += read
            return read
        } catch (error: IOException) {
            fail(error)
        }
    }

    private fun beginChunk() {
        if (needsTerminator) {
            requireProtocol(source.read() == CR.toInt() && source.read() == LF.toInt())
            needsTerminator = false
        }
        val raw = lines.read(limits.maxHeaderBytes)
        framingBytes += raw.size + 2L
        chunkCount += 1
        if (framingBytes > limits.maxHeaderBytes || chunkCount > limits.maxHeaders * 8) {
            throw HttpResponseLimitExceeded()
        }
        val line = raw.toLatin1()
        requireProtocol(line.all(::isHeaderByte) && !hasInvalidHttpText(line))
        requireProtocol(HEXADECIMAL.matches(line))
        val size = line.toLongOrNull(16) ?: throw HttpResponseLimitExceeded()
        if (size > limits.maxResponseBodyBytes.toLong() - total) throw HttpResponseLimitExceeded()
        if (size == 0L) {
            readTrailers()
            remaining = -1L
            finish()
            return
        }
        remaining = size
        needsTerminator = true
    }

    private fun readTrailers() {
        while (true) {
            val raw = lines.read(limits.maxHeaderBytes)
            headerBudget.consumeBytes(raw.size + 2)
            if (raw.isEmpty()) return
            requireProtocol(raw[0] != SPACE && raw[0] != TAB)
            val separator = raw.indexOf(COLON)
            requireProtocol(separator > 0)
            val name = raw.copyOfRange(0, separator).toLatin1().lowercase()
            requireProtocol(HTTP_TOKEN.matches(name) && name !in FORBIDDEN_TRAILER_HEADERS)
            val value = raw.copyOfRange(separator + 1, raw.size).toLatin1().trimHttpWhitespace()
            requireProtocol(!hasInvalidHttpText(value))
            headerBudget.consumeHeader()
        }
    }
}

private fun writeHttpLine(output: OutputStream, value: String) {
    require(value.all(::isHeaderByte) && !value.contains('\r') && !value.contains('\n'))
    output.write(value.toByteArray(StandardCharsets.ISO_8859_1))
    output.write(CRLF)
}

private fun ByteArray.toLatin1(): String = String(this, StandardCharsets.ISO_8859_1)

private fun String.trimHttpWhitespace(): String = trim { it == ' ' || it == '\t' }

private fun requireProtocol(condition: Boolean) {
    if (!condition) throw HttpProtocolException("invalid HTTP/1.1 framing")
}

private fun isVisibleAscii(character: Char): Boolean = character.code in 0x21..0x7E

private fun isHeaderByte(character: Char): Boolean = character.code in 0x09..0xFF

private const val MAX_INFORMATIONAL_RESPONSES = 8
private val CR = '\r'.code.toByte()
private val LF = '\n'.code.toByte()
private val SPACE = ' '.code.toByte()
private val TAB = '\t'.code.toByte()
private val COLON = ':'.code.toByte()
private val CRLF = byteArrayOf(CR, LF)
private val DECIMAL = Regex("^[0-9]{1,19}$")
private val HEXADECIMAL = Regex("^[0-9A-Fa-f]{1,16}$")
private val HTTP_TOKEN = Regex("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")
private val STATUS_LINE = Regex("^HTTP/1\\.[01] ([0-9]{3})(?:[ \\t](.*))?$")
internal val HTTP_MANAGED_REQUEST_HEADERS = setOf(
    "accept-encoding",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "expect",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
)
private val FORBIDDEN_TRAILER_HEADERS = HTTP_MANAGED_REQUEST_HEADERS + setOf("authorization")
