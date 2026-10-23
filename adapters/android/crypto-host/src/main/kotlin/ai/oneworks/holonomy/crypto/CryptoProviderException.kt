package ai.oneworks.holonomy.crypto

/** Fixed codes only: neither platform exception text nor cause crosses the engine boundary. */
class CryptoProviderException internal constructor(val code: String) : RuntimeException(code) {
    companion object {
        const val OPERATION_FAILED = "ERR_HOLONOMY_CRYPTO_OPERATION_FAILED"
        const val RESOURCE_EXHAUSTED = "ERR_HOLONOMY_RESOURCE_EXHAUSTED"
    }
}

internal fun invalid(): Nothing = throw CryptoProviderException(CryptoProviderException.OPERATION_FAILED)
internal fun exhausted(): Nothing = throw CryptoProviderException(CryptoProviderException.RESOURCE_EXHAUSTED)
