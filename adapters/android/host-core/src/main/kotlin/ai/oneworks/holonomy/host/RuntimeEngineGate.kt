package ai.oneworks.holonomy.host

import java.security.MessageDigest

enum class RuntimeEngineCodeKind(val operation: String) {
    STRINGS("runtime.code.generate.strings"),
    WASM("runtime.code.generate.wasm"),
}

class RuntimeEngineGateRequest(
    val codeKind: RuntimeEngineCodeKind,
    source: ByteArray,
    val isCodeLike: Boolean,
) {
    private val sourceSnapshot = source.copyOf()

    val sourceBytes: Int = sourceSnapshot.size
    val sourceSha256: String = MessageDigest.getInstance("SHA-256")
        .digest(sourceSnapshot)
        .joinToString("") { byte -> "%02x".format(byte) }

    fun copySource(maxBytes: Int): ByteArray {
        require(maxBytes >= 0) { "Engine source limit must not be negative" }
        return sourceSnapshot.copyOfRange(0, minOf(sourceSnapshot.size, maxBytes))
    }
}

data class RuntimeEngineGateDecision(
    val action: Action,
    val reasonCode: String? = null,
) {
    enum class Action {
        ALLOW,
        DENY,
    }

    init {
        require(
            action == Action.ALLOW && reasonCode == null ||
                action == Action.DENY && !reasonCode.isNullOrBlank(),
        ) { "Invalid Runtime Engine Gate decision" }
    }

    companion object {
        val Allow = RuntimeEngineGateDecision(Action.ALLOW)

        fun deny(reasonCode: String) = RuntimeEngineGateDecision(Action.DENY, reasonCode)
    }
}

fun interface RuntimeEngineGate : AutoCloseable {
    /** Runs synchronously on the owned Runtime thread. Throwing always fails closed. */
    fun decide(request: RuntimeEngineGateRequest): RuntimeEngineGateDecision

    override fun close() = Unit
}
