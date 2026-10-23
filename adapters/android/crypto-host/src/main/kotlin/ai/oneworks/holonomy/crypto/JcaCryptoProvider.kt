package ai.oneworks.holonomy.crypto

import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Synchronous engine-private intrinsics. Construct one per Runtime on its runtime thread.
 * IDs are local, non-reused transport tokens and must never be exposed to guest code.
 * No NativeBridge, executor, Keystore, Binder, guest-directed I/O or JavaScript calls.
 * Construction warms OS entropy; subsequent calls still depend on platform CSPRNG behavior.
 */
class JcaCryptoProvider @JvmOverloads constructor(private val limits: CryptoLimits = CryptoLimits()) {
    class FinalResult internal constructor(
        val output: ByteArray,
        val authTag: ByteArray? = null,
        val authenticated: Boolean? = null,
    )

    private val owner = Thread.currentThread()
    private val random = secure { SecureRandom().also { source ->
        val warmup = ByteArray(32)
        try { source.nextBytes(warmup) } finally { warmup.fill(0) }
    } }
    private val contexts = HashMap<Int, Record>()
    private var nextId = 0
    private var retained = 0L
    private var disposed = false

    private fun thread() { if (Thread.currentThread() !== owner) invalid() }
    private fun active() { thread(); if (disposed) invalid() }
    private fun record(id: Int): Record { active(); return contexts[id] ?: invalid() }
    private fun room(size: Long) {
        if (size < 0 || size > limits.maxInFlightContextBytes.toLong() - retained) exhausted()
    }

    /** 0=SHA1, 1=SHA256, 2=HMACSHA256, 3=AES256GCM encrypt, 4=decrypt. */
    fun createContext(kind: Int, key: ByteArray, iv: ByteArray): Int {
        active()
        if (kind !in 0..4 || (kind < 2 && key.isNotEmpty()) ||
            (kind < 3 && iv.isNotEmpty()) || (kind >= 3 && (key.size != 32 || iv.size != 12))
        ) invalid()
        if (key.size > limits.maxHmacKeyBytes || contexts.size >= limits.maxContexts || nextId == Int.MAX_VALUE) exhausted()
        room(key.size.toLong() + iv.size)
        val copy = key.copyOf()
        val nonce = iv.copyOf()
        val value = try {
            secure {
                when (kind) {
                    0, 1 -> Record(kind, digest = MessageDigest.getInstance(if (kind == 0) "SHA-1" else "SHA-256"))
                    2 -> {
                        // JCA rejects an empty SecretKeySpec; HMAC's padded zero block makes
                        // one zero byte equivalent to the empty key for SHA-256.
                        val material = if (copy.isEmpty()) byteArrayOf(0) else copy
                        try {
                            Record(kind, mac = Mac.getInstance("HmacSHA256").also {
                                it.init(SecretKeySpec(material, "HmacSHA256"))
                            })
                        } finally { if (material !== copy) material.fill(0) }
                    }
                    else -> Record(kind, key = copy.copyOf(), iv = nonce.copyOf())
                }
            }
        } finally { copy.fill(0); nonce.fill(0) }
        value.retained = key.size.toLong() + iv.size
        retained += value.retained
        val id = ++nextId
        contexts[id] = value
        return id
    }

    fun update(id: Int, data: ByteArray): ByteArray {
        val value = record(id)
        if (data.size > limits.maxUpdateBytesPerCall || data.size > limits.maxContextBytes - value.dataBytes) exhausted()
        reserve(value, data.size)
        value.dataBytes += data.size
        value.started = true
        try {
            secure {
                when (value.kind) {
                    0, 1 -> value.digest!!.update(data)
                    2 -> value.mac!!.update(data)
                    else -> value.data.append(data)
                }
            }
        } catch (failure: CryptoProviderException) { release(id); throw failure }
        return ByteArray(0)
    }

    fun setAAD(id: Int, aad: ByteArray) {
        val value = record(id)
        if (value.kind < 3 || value.started) invalid()
        if (aad.size > limits.maxAadBytes - value.aad.size) exhausted()
        reserve(value, aad.size)
        value.aad.append(aad)
    }

    fun setAuthTag(id: Int, tag: ByteArray) {
        val value = record(id)
        if (value.kind != 4 || value.tag != null || tag.size != 16) invalid()
        reserve(value, tag.size)
        value.tag = tag.copyOf()
    }

    fun digest(id: Int): ByteArray {
        val value = record(id)
        if (value.kind > 2) invalid()
        try { return secure { value.digest?.digest() ?: value.mac!!.doFinal() } }
        finally { release(id) }
    }

    fun finalContext(id: Int): FinalResult {
        val value = record(id)
        if (value.kind < 3) invalid()
        try {
            if (value.kind == 4 && value.tag == null) invalid()
            return secure { finish(value) }
        } finally { release(id) }
    }

    private fun finish(value: Record): FinalResult {
        val decrypt = value.kind == 4
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(if (decrypt) Cipher.DECRYPT_MODE else Cipher.ENCRYPT_MODE,
            SecretKeySpec(value.key!!, "AES"), GCMParameterSpec(128, value.iv))
        value.aad.withBytes { bytes, size -> cipher.updateAAD(bytes, 0, size) }
        val input = value.data.join(if (decrypt) value.tag else null)
        val output = ByteArray(cipher.getOutputSize(input.size))
        try {
            val count = try { cipher.doFinal(input, 0, input.size, output, 0) }
            catch (_: BadPaddingException) {
                if (!decrypt) invalid()
                return FinalResult(ByteArray(0), authenticated = false)
            }
            return if (decrypt) FinalResult(output.copyOf(count), authenticated = true)
            else {
                if (count != value.dataBytes + 16) invalid()
                FinalResult(output.copyOfRange(0, count - 16), output.copyOfRange(count - 16, count))
            }
        } finally { input.fill(0); output.fill(0) }
    }

    fun randomBytes(size: Int): ByteArray {
        active()
        if (size < 0) invalid()
        if (size > limits.maxRandomBytesPerCall) exhausted()
        room(size.toLong())
        val output = ByteArray(size)
        try { secure { random.nextBytes(output) }; return output }
        catch (failure: CryptoProviderException) { output.fill(0); throw failure }
    }

    fun timingSafeEqual(left: ByteArray, right: ByteArray): Boolean {
        active()
        if (left.size != right.size) invalid()
        if (left.size > limits.maxCompareBytes) exhausted()
        room(left.size.toLong() * 2)
        return secure { MessageDigest.isEqual(left, right) }
    }

    fun disposeContext(id: Int) { thread(); release(id) }
    fun dispose() {
        thread()
        if (disposed) return
        disposed = true
        contexts.values.forEach { it.clear() }
        contexts.clear()
        retained = 0
    }

    private fun reserve(value: Record, size: Int) {
        room(size.toLong())
        retained += size
        value.retained += size
    }
    private fun release(id: Int) {
        val value = contexts.remove(id) ?: return
        retained -= value.retained
        value.clear()
    }
    private inline fun <T> secure(action: () -> T): T = try { action() }
    catch (failure: CryptoProviderException) { throw failure }
    catch (_: GeneralSecurityException) { invalid() }
    catch (_: RuntimeException) { invalid() }

    private class Record(
        val kind: Int,
        val digest: MessageDigest? = null,
        val mac: Mac? = null,
        val key: ByteArray? = null,
        val iv: ByteArray? = null,
    ) {
        val data = WipingBytes(64 * 1024 * 1024)
        val aad = WipingBytes(64 * 1024)
        var tag: ByteArray? = null
        var retained = 0L
        var dataBytes = 0
        var started = false
        fun clear() {
            key?.fill(0); iv?.fill(0); tag?.fill(0)
            tag = null
            data.clear(); aad.clear()
            try { digest?.reset(); mac?.reset() } catch (_: RuntimeException) { /* best effort */ }
            // JCA provider internals and VM copies cannot be guaranteed erased.
        }
    }

    private class WipingBytes(private val capacityLimit: Int) {
        private var storage = ByteArray(0)
        var size = 0
            private set
        fun append(bytes: ByteArray) {
            if (bytes.isEmpty()) return
            val needed = size + bytes.size
            if (needed > capacityLimit) exhausted()
            if (needed > storage.size) {
                val replacement = ByteArray(maxOf(needed, minOf(capacityLimit, maxOf(32, storage.size * 2))))
                storage.copyInto(replacement, 0, 0, size)
                storage.fill(0)
                storage = replacement
            }
            bytes.copyInto(storage, size)
            size += bytes.size
        }
        fun withBytes(action: (ByteArray, Int) -> Unit) { action(storage, size) }
        fun join(tail: ByteArray?): ByteArray {
            val output = ByteArray(size + (tail?.size ?: 0))
            storage.copyInto(output, 0, 0, size)
            tail?.copyInto(output, size)
            return output
        }
        fun clear() { storage.fill(0); storage = ByteArray(0); size = 0 }
    }
}
