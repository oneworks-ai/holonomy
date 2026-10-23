package ai.oneworks.holonomy.crypto

import ai.oneworks.holonomy.host.RuntimeCryptoHost
import ai.oneworks.holonomy.host.RuntimeCryptoFinalResult
import org.json.JSONObject

/** Construct through RuntimeEngineFactory.cryptoHostFactory on the owning Runtime thread. */
class AndroidRuntimeCryptoHost(
    private val limits: CryptoLimits = CryptoLimits(
        maxContexts = 16, maxContextBytes = 8 * 1024 * 1024, maxInFlightContextBytes = 16 * 1024 * 1024,
    ),
) : RuntimeCryptoHost {
    private val provider = JcaCryptoProvider(limits)
    override fun limitsJson(): String = JSONObject()
        .put("maxAadBytes", limits.maxAadBytes).put("maxContextBytes", limits.maxContextBytes)
        .put("maxContexts", limits.maxContexts).put("maxHmacKeyBytes", limits.maxHmacKeyBytes)
        .put("maxInFlightContextBytes", limits.maxInFlightContextBytes).put("maxCompareBytes", limits.maxCompareBytes)
        .put("maxRandomBytesPerCall", limits.maxRandomBytesPerCall).put("maxUpdateBytesPerCall", limits.maxUpdateBytesPerCall)
        .toString()
    override fun createContext(kind: Int, key: ByteArray, iv: ByteArray) = provider.createContext(kind, key, iv)
    override fun update(context: Int, data: ByteArray) = provider.update(context, data)
    override fun digest(context: Int) = provider.digest(context)
    override fun setAAD(context: Int, aad: ByteArray) = provider.setAAD(context, aad)
    override fun setAuthTag(context: Int, tag: ByteArray) = provider.setAuthTag(context, tag)
    override fun finalContext(context: Int): RuntimeCryptoFinalResult {
        val result = provider.finalContext(context)
        return RuntimeCryptoFinalResult(result.output, result.authTag, result.authenticated)
    }
    override fun randomBytes(size: Int) = provider.randomBytes(size)
    override fun timingSafeEqual(left: ByteArray, right: ByteArray) = provider.timingSafeEqual(left, right)
    override fun disposeContext(context: Int) = provider.disposeContext(context)
    override fun close() = provider.dispose()
}
