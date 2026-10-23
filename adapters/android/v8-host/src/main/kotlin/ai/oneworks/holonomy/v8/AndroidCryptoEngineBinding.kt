package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeCryptoHost
import ai.oneworks.holonomy.host.RuntimeThreadGuard
import com.caoccao.javet.enums.V8ValueType
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.V8ValueArrayBuffer
import java.util.concurrent.atomic.AtomicBoolean

/** Private binary ABI, reachable only from the reserved bootstrap's captured closure. */
internal class AndroidCryptoEngineBinding(
    private val runtime: V8Runtime,
    private val host: RuntimeCryptoHost,
    private val guard: RuntimeThreadGuard,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val kinds = mutableMapOf<Int, Int>()
    fun limitsJson(): String {
        guard.checkAccess()
        return host.limitsJson().also { require(it.length <= 4096) }
    }

    fun invoke(operation: Double, handle: Double, first: V8Value, second: V8Value): V8Value {
        guard.checkAccess()
        check(!closed.get())
        val op = integer(operation, 0, 9)
        val id = integer(handle, 0, Int.MAX_VALUE)
        return when (op) {
            0 -> withBytes(first, KEY_BYTES) { key -> withBytes(second, 12) { iv ->
                require(id in 0..4)
                val context = host.createContext(id, key, iv)
                check(context > 0 && kinds.putIfAbsent(context, id) == null)
                runtime.createV8ValueInteger(context)
            } }
            1 -> withBytes(first, UPDATE_BYTES) { bytes -> output(host.update(known(id), bytes)) }
            2 -> output(host.digest(known(id))).also { kinds.remove(id) }
            3 -> withBytes(first, KEY_BYTES) { bytes -> host.setAAD(known(id), bytes); runtime.createV8ValueUndefined() }
            4 -> withBytes(first, 16) { bytes -> host.setAuthTag(known(id), bytes); runtime.createV8ValueUndefined() }
            5 -> finish(known(id))
            6 -> { require(id <= KEY_BYTES); output(host.randomBytes(id)) }
            7 -> withBytes(first, UPDATE_BYTES) { left -> withBytes(second, UPDATE_BYTES) { right ->
                runtime.createV8ValueBoolean(host.timingSafeEqual(left, right))
            } }
            8 -> { kinds.remove(id); host.disposeContext(id); runtime.createV8ValueUndefined() }
            else -> { close(); runtime.createV8ValueUndefined() }
        }
    }

    private fun finish(id: Int): V8Value {
        val kind = requireNotNull(kinds[id])
        val result = host.finalContext(id)
        kinds.remove(id)
        try {
            require(result.output.size <= CONTEXT_BYTES)
            val tag = result.authTag
            if (kind == 3) require(tag?.size == 16 && result.authenticated == null)
            else require(kind == 4 && tag == null && result.authenticated != null)
            if (result.authenticated == false) require(result.output.isEmpty())
            val packet = ByteArray(1 + result.output.size + (tag?.size ?: 0))
            packet[0] = if (result.authenticated == false) 0 else 1
            result.output.copyInto(packet, 1)
            tag?.copyInto(packet, 1 + result.output.size)
            return output(packet)
        } finally {
            result.output.fill(0)
            result.authTag?.fill(0)
        }
    }

    private fun known(id: Int): Int { require(kinds.containsKey(id)); return id }

    private fun integer(value: Double, minimum: Int, maximum: Int): Int {
        require(value.isFinite() && value >= minimum && value <= maximum && value == value.toInt().toDouble())
        return value.toInt()
    }

    private inline fun <T> withBytes(value: V8Value, maximum: Int, use: (ByteArray) -> T): T {
        require(value is V8ValueArrayBuffer && value.type == V8ValueType.ArrayBuffer)
        // getByteBuffer() is a native-backed field. Javet TypedArray helpers
        // consult replaceable JS `buffer`/`byteLength` properties instead.
        val buffer = value.byteBuffer.duplicate()
        require(buffer.capacity() in 0..maximum)
        buffer.clear()
        val bytes = ByteArray(buffer.capacity())
        buffer.get(bytes)
        try { return use(bytes) } finally { bytes.fill(0) }
    }

    private fun output(bytes: ByteArray): V8ValueArrayBuffer {
        try {
            require(bytes.size <= CONTEXT_BYTES + 17)
            val value = runtime.createV8ValueArrayBuffer(bytes.size)
            try { value.byteBuffer.duplicate().apply { clear(); put(bytes) }; return value }
            catch (error: Throwable) { value.close(); throw error }
        } finally { bytes.fill(0) }
    }

    override fun close() {
        guard.checkAccess()
        if (!closed.compareAndSet(false, true)) return
        kinds.clear()
        host.close()
    }

    private companion object {
        const val KEY_BYTES = 64 * 1024
        const val UPDATE_BYTES = 1024 * 1024
        const val CONTEXT_BYTES = 64 * 1024 * 1024
    }
}
