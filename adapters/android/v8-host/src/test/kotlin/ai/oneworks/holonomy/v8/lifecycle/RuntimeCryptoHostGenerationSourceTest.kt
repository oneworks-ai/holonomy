package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeCryptoHost
import ai.oneworks.holonomy.host.RuntimeCryptoFinalResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class RuntimeCryptoHostGenerationSourceTest {
    @Test
    fun `constructor failure closes new crypto host exactly once and preserves failure`() {
        val host = ProbeCryptoHost()
        val source = RuntimeCryptoHostGenerationSource { host }
        val failure = IllegalStateException("constructor failed")
        val actual = assertThrows(IllegalStateException::class.java) {
            source.createOwned<Unit> { throw failure }
        }
        assertSame(failure, actual)
        assertEquals(1, host.closes)
    }

    @Test
    fun `successful construction transfers ownership and restart requires a fresh host`() {
        val host = ProbeCryptoHost()
        val source = RuntimeCryptoHostGenerationSource { host }
        assertSame(host, source.createOwned { it })
        assertEquals(0, host.closes)
        assertThrows(IllegalStateException::class.java) { source.createOwned { it } }
        assertEquals(0, host.closes)
        host.close()
        assertEquals(1, host.closes)
    }

    private class ProbeCryptoHost : RuntimeCryptoHost {
        var closes = 0
        override fun createContext(kind: Int, key: ByteArray, iv: ByteArray) = 1
        override fun update(context: Int, data: ByteArray) = byteArrayOf()
        override fun digest(context: Int) = byteArrayOf()
        override fun setAAD(context: Int, aad: ByteArray) = Unit
        override fun setAuthTag(context: Int, tag: ByteArray) = Unit
        override fun finalContext(context: Int) = RuntimeCryptoFinalResult(byteArrayOf())
        override fun randomBytes(size: Int) = ByteArray(size)
        override fun timingSafeEqual(left: ByteArray, right: ByteArray) = left.contentEquals(right)
        override fun disposeContext(context: Int) = Unit
        override fun close() { closes += 1 }
    }
}
