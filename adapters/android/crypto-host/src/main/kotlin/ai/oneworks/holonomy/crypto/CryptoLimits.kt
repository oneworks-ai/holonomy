package ai.oneworks.holonomy.crypto

/** Defense in depth; the shared CryptoPrimitivePort remains the public quota owner. */
data class CryptoLimits(
    val maxAadBytes: Int = 64 * 1024,
    val maxContextBytes: Int = 64 * 1024 * 1024,
    val maxContexts: Int = 64,
    val maxHmacKeyBytes: Int = 64 * 1024,
    val maxInFlightContextBytes: Int = 128 * 1024 * 1024,
    val maxCompareBytes: Int = 1024 * 1024,
    val maxRandomBytesPerCall: Int = 64 * 1024,
    val maxUpdateBytesPerCall: Int = 1024 * 1024,
) {
    init {
        if (maxAadBytes !in 1..65536 || maxContextBytes !in 1..67108864 ||
            maxContexts !in 1..64 || maxHmacKeyBytes !in 1..65536 ||
            maxInFlightContextBytes !in 1..134217728 || maxCompareBytes !in 1..1048576 ||
            maxRandomBytesPerCall !in 1..65536 || maxUpdateBytesPerCall !in 1..1048576 ||
            maxUpdateBytesPerCall > maxContextBytes || maxContextBytes > maxInFlightContextBytes ||
            maxAadBytes > maxInFlightContextBytes || maxHmacKeyBytes > maxInFlightContextBytes ||
            maxCompareBytes.toLong() * 2 > maxInFlightContextBytes
        ) invalid()
    }
}
