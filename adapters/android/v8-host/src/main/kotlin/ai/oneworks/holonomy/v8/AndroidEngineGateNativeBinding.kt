package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeEngineCodeKind
import ai.oneworks.holonomy.host.RuntimeEngineGate
import ai.oneworks.holonomy.host.RuntimeEngineGateDecision
import ai.oneworks.holonomy.host.RuntimeEngineGateRequest
import java.util.concurrent.atomic.AtomicBoolean

internal class AndroidEngineGateNativeBinding(
    private val gate: RuntimeEngineGate,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)
    private var bindingHandle = nativeInstall()

    init {
        check(bindingHandle != 0L) { "The Android per-compilation Engine Gate is unavailable" }
    }

    fun armFromCurrentIsolate() {
        check(!closed.get() && nativeArm(bindingHandle)) {
            "The Android per-compilation Engine Gate could not bind the current V8 isolate"
        }
    }

    @Suppress("unused")
    private fun decideNative(kind: Int, source: ByteArray, isCodeLike: Boolean): Boolean = runCatching {
        val codeKind = when (kind) {
            NATIVE_KIND_STRINGS -> RuntimeEngineCodeKind.STRINGS
            NATIVE_KIND_WASM -> RuntimeEngineCodeKind.WASM
            else -> return false
        }
        gate.decide(RuntimeEngineGateRequest(codeKind, source, isCodeLike)).action ==
            RuntimeEngineGateDecision.Action.ALLOW
    }.getOrDefault(false)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val handle = bindingHandle
        bindingHandle = 0L
        if (handle != 0L) nativeUninstall(handle)
        runCatching { gate.close() }
    }

    private external fun nativeInstall(): Long

    private external fun nativeArm(bindingHandle: Long): Boolean

    private external fun nativeUninstall(bindingHandle: Long)

    private companion object {
        private const val NATIVE_KIND_STRINGS = 1
        private const val NATIVE_KIND_WASM = 2

        init {
            System.loadLibrary("holonomy_engine_gate")
        }
    }
}
