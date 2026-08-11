package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.DedicatedThreadRuntimeEngine
import ai.oneworks.holonomy.host.RuntimeAdapter
import ai.oneworks.holonomy.host.RuntimeAdapterFactory
import ai.oneworks.holonomy.host.RuntimeAdapterHost
import ai.oneworks.holonomy.host.RuntimeCapabilities
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeEngineException
import ai.oneworks.holonomy.host.RuntimeEvaluation
import ai.oneworks.holonomy.host.RuntimeImplementationStage
import ai.oneworks.holonomy.host.RuntimeMicrotaskMode
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import ai.oneworks.holonomy.host.RuntimeThreadGuard
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

class RuntimeNativeHostGenerationTest {
    @Test
    fun `restart creates a fresh host and drops events from the closed generation`() {
        val hosts = mutableListOf<RecordingNativeHost>()
        val source = RuntimeNativeHostGenerationSource.restartable {
            RecordingNativeHost().also(hosts::add)
        }
        val factory = NativeHostLifecycleAdapterFactory(source)
        val engine = DedicatedThreadRuntimeEngine(factory)
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val first = factory.adapters.single()

            engine.terminate().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val second = factory.adapters.last()
            assertEquals(2, hosts.size)
            assertNotSame(first.nativeHost, second.nativeHost)
            assertEquals(1, first.nativeHost.closeCount.get())

            first.emitLateEvent()
            engine.evaluate("generation-barrier").get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(0, first.nativeHost.eventCount.get())

            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(listOf(1, 1), hosts.map { host -> host.closeCount.get() })
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `single host overload source fails closed after its first generation`() {
        val nativeHost = RecordingNativeHost()
        val factory = NativeHostLifecycleAdapterFactory(
            RuntimeNativeHostGenerationSource.oneGeneration(nativeHost),
        )
        val engine = OneGenerationRuntimeEngine(DedicatedThreadRuntimeEngine(factory))
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.terminate().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(1, nativeHost.closeCount.get())
            assertEquals(1, factory.adapters.size)

            val restart = assertThrows(ExecutionException::class.java) {
                engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            }
            assertEquals(RuntimeEngineErrorCode.DISPOSED, (restart.cause as RuntimeEngineException).code)
            assertEquals(1, nativeHost.closeCount.get())
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `restartable host factory rejects an already issued identity`() {
        val nativeHost = RecordingNativeHost()
        val source = RuntimeNativeHostGenerationSource.restartable { nativeHost }

        assertSame(nativeHost, source.create())
        assertThrows(IllegalStateException::class.java) { source.create() }
    }

    private class NativeHostLifecycleAdapterFactory(
        private val source: RuntimeNativeHostGenerationSource,
    ) : RuntimeAdapterFactory {
        override val capabilities = RuntimeCapabilities(
            implementationStage = RuntimeImplementationStage.BOOTSTRAP,
            microtaskMode = RuntimeMicrotaskMode.AUTO,
            esmModules = true,
            inspectorEnabled = false,
        )
        val adapters = mutableListOf<NativeHostLifecycleAdapter>()

        override fun create(
            threadGuard: RuntimeThreadGuard,
            host: RuntimeAdapterHost,
        ): RuntimeAdapter = NativeHostLifecycleAdapter(
            source.create() as RecordingNativeHost,
            host,
        ).also(adapters::add)
    }

    private class NativeHostLifecycleAdapter(
        val nativeHost: RecordingNativeHost,
        private val host: RuntimeAdapterHost,
    ) : RuntimeAdapter {
        override fun start() = Unit

        override fun evaluate(source: String) = RuntimeEvaluation(RuntimeEvaluation.Kind.UNDEFINED)

        override fun executeModule(module: RuntimeModuleSource) = Unit

        override fun terminateExecution() = Unit

        override fun close() = nativeHost.close()

        fun emitLateEvent() = host.requestRuntimeTask { nativeHost.eventCount.incrementAndGet() }
    }

    private class RecordingNativeHost : RuntimeNativeHost {
        val closeCount = AtomicInteger(0)
        val eventCount = AtomicInteger(0)

        override fun dispatch(
            requestId: String,
            requestJson: String,
            contextJson: String,
            binary: List<RuntimeNativeBinary>,
            sink: RuntimeNativeEventSink,
            resourceSink: RuntimeNativeResourceEventSink,
        ) = Unit

        override fun close() {
            closeCount.incrementAndGet()
        }
    }

    private companion object {
        private const val TIMEOUT_SECONDS = 5L
    }
}
