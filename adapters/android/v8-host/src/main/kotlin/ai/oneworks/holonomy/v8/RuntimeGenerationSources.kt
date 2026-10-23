package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityServices
import ai.oneworks.holonomy.host.RuntimeCryptoHost
import ai.oneworks.holonomy.host.RuntimeEngineGate
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import java.lang.ref.WeakReference

internal class RuntimeCapabilityHostGenerationSource private constructor(
    factory: () -> RuntimeCapabilityHost,
    restartable: Boolean,
) {
    private val delegate = GenerationSource(factory, restartable, "RuntimeCapabilityHost")

    fun create(): RuntimeCapabilityHost = delegate.create()

    companion object {
        fun oneGeneration(host: RuntimeCapabilityHost) = RuntimeCapabilityHostGenerationSource({ host }, false)
        fun restartable(factory: () -> RuntimeCapabilityHost) = RuntimeCapabilityHostGenerationSource(factory, true)
    }
}

internal class RuntimeNativeHostGenerationSource private constructor(
    factory: () -> RuntimeNativeHost,
    restartable: Boolean,
) {
    private val delegate = GenerationSource(factory, restartable, "RuntimeNativeHost")

    fun create(): RuntimeNativeHost = delegate.create()

    companion object {
        fun oneGeneration(host: RuntimeNativeHost) = RuntimeNativeHostGenerationSource({ host }, false)
        fun restartable(factory: () -> RuntimeNativeHost) = RuntimeNativeHostGenerationSource(factory, true)
    }
}

internal class RuntimeTrustedBackendGenerationSource private constructor(
    factory: () -> RuntimeTrustedBackend,
    restartable: Boolean,
) {
    private val delegate = GenerationSource(factory, restartable, "RuntimeTrustedBackend")

    fun create(): RuntimeTrustedBackend = delegate.create()

    companion object {
        fun oneGeneration(backend: RuntimeTrustedBackend) = RuntimeTrustedBackendGenerationSource({ backend }, false)
        fun restartable(factory: () -> RuntimeTrustedBackend) = RuntimeTrustedBackendGenerationSource(factory, true)
    }
}

internal class RuntimeCapabilityServicesGenerationSource(
    factory: () -> RuntimeCapabilityServices,
) {
    private val delegate = GenerationSource(factory, true, "RuntimeCapabilityServices")

    fun create(): RuntimeCapabilityServices = delegate.create()
}

internal class RuntimeEngineGateGenerationSource private constructor(
    factory: () -> RuntimeEngineGate,
    restartable: Boolean,
) {
    private val delegate = GenerationSource(factory, restartable, "RuntimeEngineGate")

    fun create(): RuntimeEngineGate = delegate.create()

    companion object {
        fun oneGeneration(gate: RuntimeEngineGate) = RuntimeEngineGateGenerationSource({ gate }, false)
        fun restartable(factory: () -> RuntimeEngineGate) = RuntimeEngineGateGenerationSource(factory, true)
    }
}

internal class RuntimeCryptoHostGenerationSource(factory: () -> RuntimeCryptoHost) {
    private val delegate = GenerationSource(factory, true, "RuntimeCryptoHost")
    fun create(): RuntimeCryptoHost = delegate.create()

    fun <T> createOwned(construct: (RuntimeCryptoHost) -> T): T {
        val host = create()
        try { return construct(host) }
        catch (error: Throwable) {
            runCatching { host.close() }
            throw error
        }
    }
}

private class GenerationSource<T : Any>(
    private val factory: () -> T,
    private val restartable: Boolean,
    private val kind: String,
) {
    private val issued = mutableListOf<WeakReference<T>>()
    private var generationClaimed = false

    @Synchronized
    fun create(): T {
        check(restartable || !generationClaimed) { "$kind instance cannot be reused by a restarted runtime" }
        val value = factory()
        issued.removeAll { reference -> reference.get() == null }
        check(issued.none { reference -> reference.get() === value }) {
            "$kind factory must return a fresh instance for each generation"
        }
        generationClaimed = true
        issued += WeakReference(value)
        return value
    }
}
