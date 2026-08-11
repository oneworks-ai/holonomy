package ai.oneworks.holonomy.v8

import android.net.LocalSocket
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

internal class InspectorWebSocket(
    private val socket: LocalSocket,
    private val maxMessageBytes: Int,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val input: InputStream = socket.inputStream
    private val output: OutputStream = socket.outputStream
    private val writeLock = Any()

    fun flush() {
        synchronized(writeLock) {
            if (!closed.get()) output.flush()
        }
    }

    fun readMessages(onText: (String) -> Unit) {
        var fragmentedOpcode: Int? = null
        var fragments: ByteArrayOutputStream? = null
        while (!closed.get()) {
            val first = input.read()
            if (first < 0) return
            val second = readByte(input)
            val final = first and FIN_MASK != 0
            val opcode = first and OPCODE_MASK
            require(first and RESERVED_MASK == 0) { "WebSocket extensions are not supported" }
            require(second and MASK_MASK != 0) { "DevTools WebSocket client frames must be masked" }
            val length = readLength(second and LENGTH_MASK)
            require(length <= maxMessageBytes) { "The DevTools message is too large" }
            val mask = readExact(input, MASK_BYTES)
            val payload = readExact(input, length)
            for (index in payload.indices) payload[index] = (payload[index].toInt() xor mask[index % MASK_BYTES].toInt()).toByte()

            when (opcode) {
                OPCODE_CONTINUATION -> {
                    val stream = requireNotNull(fragments) { "Unexpected WebSocket continuation frame" }
                    appendBounded(stream, payload)
                    if (final) {
                        require(fragmentedOpcode == OPCODE_TEXT) { "Only text DevTools messages are supported" }
                        onText(decodeUtf8(stream.toByteArray()))
                        fragments = null
                        fragmentedOpcode = null
                    }
                }
                OPCODE_TEXT -> {
                    require(fragments == null) { "A fragmented DevTools message is already open" }
                    if (final) {
                        onText(decodeUtf8(payload))
                    } else {
                        fragmentedOpcode = opcode
                        fragments = ByteArrayOutputStream(payload.size).also { appendBounded(it, payload) }
                    }
                }
                OPCODE_CLOSE -> {
                    require(final && payload.size <= MAX_CONTROL_BYTES) { "The WebSocket close frame is invalid" }
                    sendControl(OPCODE_CLOSE, payload)
                    return
                }
                OPCODE_PING -> {
                    require(final && payload.size <= MAX_CONTROL_BYTES) { "The WebSocket ping frame is invalid" }
                    sendControl(OPCODE_PONG, payload)
                }
                OPCODE_PONG -> require(final && payload.size <= MAX_CONTROL_BYTES) {
                    "The WebSocket pong frame is invalid"
                }
                else -> error("The WebSocket opcode is unsupported")
            }
        }
    }

    fun sendText(message: String) {
        val payload = message.toByteArray(StandardCharsets.UTF_8)
        require(payload.size <= maxMessageBytes) { "The inspector output message is too large" }
        sendFrame(OPCODE_TEXT, payload)
    }

    fun shutdown(code: Int = 1001) {
        if (!closed.compareAndSet(false, true)) return
        runCatching {
            val payload = byteArrayOf((code ushr 8).toByte(), code.toByte())
            synchronized(writeLock) { writeFrame(output, OPCODE_CLOSE, payload) }
        }
        runCatching { socket.close() }
    }

    override fun close() = shutdown()

    private fun appendBounded(stream: ByteArrayOutputStream, payload: ByteArray) {
        require(stream.size() <= maxMessageBytes - payload.size) { "The DevTools message is too large" }
        stream.write(payload)
    }

    private fun decodeUtf8(payload: ByteArray): String = StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(payload))
        .toString()

    private fun readLength(shortLength: Int): Int = when (shortLength) {
        LENGTH_16 -> {
            val bytes = readExact(input, 2)
            ((bytes[0].toInt() and 0xff) shl 8) or (bytes[1].toInt() and 0xff)
        }
        LENGTH_64 -> {
            val bytes = readExact(input, 8)
            require(bytes[0].toInt() and 0x80 == 0) { "The WebSocket length is invalid" }
            var value = 0L
            for (byte in bytes) value = (value shl 8) or (byte.toLong() and 0xff)
            require(value <= Int.MAX_VALUE) { "The DevTools message is too large" }
            value.toInt()
        }
        else -> shortLength
    }

    private fun sendControl(opcode: Int, payload: ByteArray) = sendFrame(opcode, payload)

    private fun sendFrame(opcode: Int, payload: ByteArray) {
        synchronized(writeLock) {
            if (!closed.get()) writeFrame(output, opcode, payload)
        }
    }

    private companion object {
        private const val FIN_MASK = 0x80
        private const val LENGTH_16 = 126
        private const val LENGTH_64 = 127
        private const val LENGTH_MASK = 0x7f
        private const val MASK_BYTES = 4
        private const val MASK_MASK = 0x80
        private const val MAX_CONTROL_BYTES = 125
        private const val OPCODE_CLOSE = 0x8
        private const val OPCODE_CONTINUATION = 0x0
        private const val OPCODE_MASK = 0x0f
        private const val OPCODE_PING = 0x9
        private const val OPCODE_PONG = 0xa
        private const val OPCODE_TEXT = 0x1
        private const val RESERVED_MASK = 0x70

        private fun readByte(input: InputStream): Int = input.read().also {
            if (it < 0) throw EOFException("The DevTools WebSocket closed unexpectedly")
        }

        private fun readExact(input: InputStream, length: Int): ByteArray = ByteArray(length).also { output ->
            var offset = 0
            while (offset < output.size) {
                val read = input.read(output, offset, output.size - offset)
                if (read < 0) throw EOFException("The DevTools WebSocket closed unexpectedly")
                offset += read
            }
        }

        private fun writeFrame(output: OutputStream, opcode: Int, payload: ByteArray) {
            output.write(FIN_MASK or opcode)
            when {
                payload.size < LENGTH_16 -> output.write(payload.size)
                payload.size <= 0xffff -> {
                    output.write(LENGTH_16)
                    output.write(payload.size ushr 8)
                    output.write(payload.size)
                }
                else -> {
                    output.write(LENGTH_64)
                    for (shift in 56 downTo 0 step 8) output.write(payload.size.toLong().ushr(shift).toInt())
                }
            }
            output.write(payload)
            output.flush()
        }
    }
}
