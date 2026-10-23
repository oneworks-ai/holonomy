package ai.oneworks.holonomy.crypto

import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class JcaCryptoProviderTest {
    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun bytes(value: String) = value.toByteArray(Charsets.US_ASCII)
    private fun failure(code: String = CryptoProviderException.OPERATION_FAILED, action: () -> Unit) {
        try { action(); fail("Expected stable failure") }
        catch (error: CryptoProviderException) {
            assertEquals(code, error.code)
            assertEquals(code, error.message)
            assertNull(error.cause)
        }
    }

    @Test fun shaKnownVectorsAndStreamingConsumeExactlyOnce() {
        val provider = JcaCryptoProvider()
        try {
            for ((kind, expected) in listOf(
                0 to "a9993e364706816aba3e25717850c26c9cd0d89d",
                1 to "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            )) {
                val id = provider.createContext(kind, byteArrayOf(), byteArrayOf())
                assertArrayEquals(byteArrayOf(), provider.update(id, bytes("a")))
                val input = bytes("bc")
                provider.update(id, input)
                input.fill(0)
                assertArrayEquals(hex(expected), provider.digest(id))
                failure { provider.digest(id) }
                provider.disposeContext(id)
                val next = provider.createContext(kind, byteArrayOf(), byteArrayOf())
                assertTrue(next > id)
                provider.disposeContext(next)
            }
            val empty = provider.createContext(1, byteArrayOf(), byteArrayOf())
            assertArrayEquals(hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), provider.digest(empty))
        } finally { provider.dispose() }
    }

    @Test fun hmacRfc4231AndEmptyKey() {
        val provider = JcaCryptoProvider()
        try {
            val key = ByteArray(20) { 0x0b }
            val id = provider.createContext(2, key, byteArrayOf())
            key.fill(0)
            provider.update(id, bytes("Hi "))
            provider.update(id, bytes("There"))
            assertArrayEquals(hex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"), provider.digest(id))
            val empty = provider.createContext(2, byteArrayOf(), byteArrayOf())
            assertArrayEquals(hex("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"), provider.digest(empty))
            val longKey = provider.createContext(2, ByteArray(131) { 0xaa.toByte() }, byteArrayOf())
            provider.update(longKey, bytes("Test Using Larger Than Block-Size Key - Hash Key First"))
            assertArrayEquals(hex("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"), provider.digest(longKey))
        } finally { provider.dispose() }
    }

    @Test fun aes256GcmNistZeroVectorAndEmptyPlaintext() {
        val provider = JcaCryptoProvider()
        try {
            val id = provider.createContext(3, ByteArray(32), ByteArray(12))
            assertEquals(0, provider.update(id, ByteArray(16)).size)
            val encrypted = provider.finalContext(id)
            assertArrayEquals(hex("cea7403d4d606b6e074ec5d3baf39d18"), encrypted.output)
            assertArrayEquals(hex("d0d1c8a799996bf0265b98b5d48ab919"), encrypted.authTag)
            assertNull(encrypted.authenticated)
            failure { provider.finalContext(id) }
            val empty = provider.createContext(3, ByteArray(32), ByteArray(12))
            val result = provider.finalContext(empty)
            assertEquals(0, result.output.size)
            assertArrayEquals(hex("530f8afbc74536b9a963b4f1c4cb738b"), result.authTag)
            val dec = provider.createContext(4, ByteArray(32), ByteArray(12))
            provider.setAuthTag(dec, result.authTag!!)
            val decrypted = provider.finalContext(dec)
            assertEquals(true, decrypted.authenticated)
            assertEquals(0, decrypted.output.size)
        } finally { provider.dispose() }
    }

    @Test fun aes256GcmNistAadVectorCopiesInputsAndRejectsTamperingWithoutPlaintext() {
        val provider = JcaCryptoProvider()
        val keyHex = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"
        val ivHex = "cafebabefacedbaddecaf888"
        val aadHex = "feedfacedeadbeeffeedfacedeadbeefabaddad2"
        val plain = hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39")
        val cipher = hex("522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662")
        val tag = hex("76fc6ece0f4e1768cddf8853bb2d551b")
        try {
            val key = hex(keyHex); val iv = hex(ivHex); val aad = hex(aadHex)
            val id = provider.createContext(3, key, iv)
            key.fill(0); iv.fill(0)
            provider.setAAD(id, aad.copyOfRange(0, 7))
            provider.setAAD(id, aad.copyOfRange(7, aad.size))
            aad.fill(0)
            val data = plain.copyOf()
            provider.update(id, data.copyOfRange(0, 17))
            provider.update(id, data.copyOfRange(17, data.size))
            data.fill(0)
            val encrypted = provider.finalContext(id)
            assertArrayEquals(cipher, encrypted.output)
            assertArrayEquals(tag, encrypted.authTag)
            for (tamper in 0..3) {
                val dec = provider.createContext(4, hex(keyHex), hex(ivHex))
                val actualAad = hex(aadHex)
                val actualCipher = cipher.copyOf()
                val actualTag = tag.copyOf()
                if (tamper == 1) actualTag[0] = (actualTag[0].toInt() xor 1).toByte()
                if (tamper == 2) actualAad[0] = (actualAad[0].toInt() xor 1).toByte()
                if (tamper == 3) actualCipher[0] = (actualCipher[0].toInt() xor 1).toByte()
                provider.setAAD(dec, actualAad)
                provider.setAuthTag(dec, actualTag)
                actualTag.fill(0)
                assertEquals(0, provider.update(dec, actualCipher.copyOfRange(0, 13)).size)
                assertEquals(0, provider.update(dec, actualCipher.copyOfRange(13, actualCipher.size)).size)
                actualCipher.fill(0)
                val result = provider.finalContext(dec)
                assertEquals(tamper == 0, result.authenticated)
                assertArrayEquals(if (tamper == 0) plain else byteArrayOf(), result.output)
                assertNull(result.authTag)
                failure { provider.finalContext(dec) }
            }
        } finally { provider.dispose() }
    }

    @Test fun strictAlgorithmsStateTagAndLifecycle() {
        val provider = JcaCryptoProvider()
        failure { provider.createContext(5, byteArrayOf(), byteArrayOf()) }
        failure { provider.createContext(0, byteArrayOf(1), byteArrayOf()) }
        failure { provider.createContext(2, byteArrayOf(), byteArrayOf(1)) }
        failure { provider.createContext(3, ByteArray(31), ByteArray(12)) }
        failure { provider.createContext(3, ByteArray(32), ByteArray(11)) }
        val enc = provider.createContext(3, ByteArray(32), ByteArray(12))
        failure { provider.digest(enc) }
        provider.update(enc, byteArrayOf())
        failure { provider.setAAD(enc, byteArrayOf(1)) }
        failure { provider.setAuthTag(enc, ByteArray(16)) }
        provider.disposeContext(enc)
        provider.disposeContext(enc)
        failure { provider.update(enc, byteArrayOf()) }
        val dec = provider.createContext(4, ByteArray(32), ByteArray(12))
        failure { provider.setAuthTag(dec, ByteArray(15)) }
        provider.setAuthTag(dec, ByteArray(16))
        failure { provider.setAuthTag(dec, ByteArray(16)) }
        provider.disposeContext(dec)
        val missing = provider.createContext(4, ByteArray(32), ByteArray(12))
        failure { provider.finalContext(missing) }
        failure { provider.setAuthTag(missing, ByteArray(16)) }
        provider.dispose(); provider.dispose(); provider.disposeContext(missing)
        failure { provider.randomBytes(0) }
        failure { provider.createContext(1, byteArrayOf(), byteArrayOf()) }
    }

    private fun tiny() = CryptoLimits(8, 8, 2, 32, 64, 8, 8, 4)

    @Test fun quotasPreflightDoNotCorruptStateAndDisposeReleasesReservations() {
        val provider = JcaCryptoProvider(tiny())
        try {
            val id = provider.createContext(1, byteArrayOf(), byteArrayOf())
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.update(id, ByteArray(5)) }
            provider.update(id, bytes("abcd")); provider.update(id, bytes("efgh"))
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.update(id, byteArrayOf(1)) }
            assertArrayEquals(hex("9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab"), provider.digest(id))
            val first = provider.createContext(2, ByteArray(32), byteArrayOf())
            val second = provider.createContext(2, ByteArray(32), byteArrayOf())
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.randomBytes(1) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.update(first, byteArrayOf(1)) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.timingSafeEqual(byteArrayOf(1), byteArrayOf(1)) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.createContext(1, byteArrayOf(), byteArrayOf()) }
            provider.disposeContext(second)
            assertEquals(8, provider.randomBytes(8).size)
            provider.update(first, byteArrayOf(1))
            provider.digest(first)
            val aes = provider.createContext(3, ByteArray(32), ByteArray(12))
            provider.setAAD(aes, ByteArray(8))
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.setAAD(aes, byteArrayOf(1)) }
            provider.disposeContext(aes)
        } finally { provider.dispose() }
    }

    @Test fun randomCompareAndInputBounds() {
        val provider = JcaCryptoProvider(tiny())
        try {
            assertEquals(0, provider.randomBytes(0).size)
            assertEquals(8, provider.randomBytes(8).size)
            failure { provider.randomBytes(-1) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.randomBytes(9) }
            assertTrue(provider.timingSafeEqual(byteArrayOf(), byteArrayOf()))
            assertTrue(provider.timingSafeEqual(bytes("same"), bytes("same")))
            assertFalse(provider.timingSafeEqual(bytes("same"), bytes("samo")))
            failure { provider.timingSafeEqual(ByteArray(1), ByteArray(2)) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.timingSafeEqual(ByteArray(9), ByteArray(9)) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.createContext(2, ByteArray(33), byteArrayOf()) }
        } finally { provider.dispose() }
    }

    @Test fun providerThreadConfinementAndInstanceIsolation() {
        val first = JcaCryptoProvider(); val second = JcaCryptoProvider()
        try {
            val id = first.createContext(1, byteArrayOf(), byteArrayOf())
            failure { second.update(id, bytes("a")) }
            val error = AtomicReference<Throwable?>()
            val other = Thread {
                try {
                    failure { first.update(id, bytes("bad")) }
                    failure { first.dispose() }
                    failure { first.disposeContext(id) }
                } catch (failure: Throwable) { error.set(failure) }
            }
            other.start(); other.join()
            error.get()?.let { throw it }
            first.update(id, bytes("abc"))
            assertArrayEquals(hex("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), first.digest(id))
        } finally { first.dispose(); second.dispose() }
    }

    @Test fun hardCeilingsAndInvalidLimits() {
        failure { CryptoLimits(maxContexts = 65) }
        failure { CryptoLimits(maxUpdateBytesPerCall = 0) }
        failure { CryptoLimits(maxContextBytes = 8) }
        val provider = JcaCryptoProvider()
        try {
            repeat(64) { provider.createContext(1, byteArrayOf(), byteArrayOf()) }
            failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.createContext(1, byteArrayOf(), byteArrayOf()) }
        } finally { provider.dispose() }
    }

    @Test fun fullQuotaIsReusableAfterFinalAndMissingTagFailure() {
        // Each AES context reserves 32 key + 12 IV + 16 tag + 4 data = 64.
        val provider = JcaCryptoProvider(CryptoLimits(4, 4, 2, 32, 64, 8, 8, 4))
        try {
            repeat(10) {
                val id = provider.createContext(4, ByteArray(32), ByteArray(12))
                provider.setAuthTag(id, ByteArray(16))
                provider.update(id, ByteArray(4))
                failure(CryptoProviderException.RESOURCE_EXHAUSTED) { provider.randomBytes(1) }
                val failed = provider.finalContext(id)
                assertEquals(false, failed.authenticated)
                assertEquals(0, failed.output.size)
                assertEquals(8, provider.randomBytes(8).size)
            }
            val missing = provider.createContext(4, ByteArray(32), ByteArray(12))
            provider.update(missing, ByteArray(4))
            failure { provider.finalContext(missing) }
            val next = provider.createContext(3, ByteArray(32), ByteArray(12))
            assertTrue(next > missing)
            provider.disposeContext(next)
        } finally { provider.dispose() }
    }
}
