package ai.oneworks.holonomy.session

import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream

internal object LengthPrefixedSessionFrames {
    fun read(input: InputStream, maxMessageBytes: Int): ByteArray {
        val length = readInt(input)
        require(length in 1..maxMessageBytes) { "Invalid session frame length" }
        return ByteArray(length).also { bytes ->
            var offset = 0
            while (offset < bytes.size) {
                val read = input.read(bytes, offset, bytes.size - offset)
                if (read < 0) throw EOFException("Truncated session frame")
                if (read == 0) continue
                offset += read
            }
        }
    }

    fun write(output: OutputStream, bytes: ByteArray, maxMessageBytes: Int) {
        require(bytes.size in 1..maxMessageBytes) { "Invalid session frame length" }
        output.write(bytes.size ushr 24)
        output.write(bytes.size ushr 16)
        output.write(bytes.size ushr 8)
        output.write(bytes.size)
        output.write(bytes)
        output.flush()
    }

    private fun readInt(input: InputStream): Int {
        val first = input.read()
        val second = input.read()
        val third = input.read()
        val fourth = input.read()
        if (first < 0 || second < 0 || third < 0 || fourth < 0) {
            throw EOFException("Truncated session frame header")
        }
        return (first shl 24) or (second shl 16) or (third shl 8) or fourth
    }
}
