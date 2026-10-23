package ai.oneworks.holonomy.host

/** Synchronous engine primitive, never a Guest-directed NativePort capability. */
interface RuntimeCryptoHost : AutoCloseable {
    /** Optional tightening of the shared hard ceilings; parsed before any Guest entry. */
    fun limitsJson(): String = "{}"
    fun createContext(kind: Int, key: ByteArray, iv: ByteArray): Int
    fun update(context: Int, data: ByteArray): ByteArray
    fun digest(context: Int): ByteArray
    fun setAAD(context: Int, aad: ByteArray)
    fun setAuthTag(context: Int, tag: ByteArray)
    fun finalContext(context: Int): RuntimeCryptoFinalResult
    fun randomBytes(size: Int): ByteArray
    fun timingSafeEqual(left: ByteArray, right: ByteArray): Boolean
    fun disposeContext(context: Int)
    override fun close()
}

/** Native-only DTO. Never converted to a Guest Java object or JSON containing secrets. */
data class RuntimeCryptoFinalResult(
    val output: ByteArray,
    val authTag: ByteArray? = null,
    val authenticated: Boolean? = null,
)
