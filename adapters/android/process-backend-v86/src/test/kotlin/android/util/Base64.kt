package android.util

/** JVM-only Android Base64 substitute used by the local Provider failure-matrix tests. */
object Base64 {
    const val DEFAULT = 0
    const val NO_WRAP = 2

    @JvmStatic
    fun decode(source: String, flags: Int): ByteArray {
        require(flags == DEFAULT || flags == NO_WRAP)
        return java.util.Base64.getDecoder().decode(source)
    }

    @JvmStatic
    fun encodeToString(source: ByteArray, flags: Int): String {
        require(flags == DEFAULT || flags == NO_WRAP)
        return java.util.Base64.getEncoder().encodeToString(source)
    }
}
