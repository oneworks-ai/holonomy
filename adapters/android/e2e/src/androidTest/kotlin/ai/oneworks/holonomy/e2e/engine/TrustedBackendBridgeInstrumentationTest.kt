package ai.oneworks.holonomy.e2e

import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.RuntimeTrustedBackendChannel
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TrustedBackendBridgeInstrumentationTest {
    @Test
    fun disposalCancelsTrustedBackendStartup() {
        val backend = ProbeBackend()
        @Suppress("DEPRECATION")
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(),
            nativeHost = FailClosedRuntimeNativeHost(),
            trustedBackend = backend,
        )
        val start = engine.start()
        assertTrue("Trusted Backend did not start", backend.started.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
        engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        assertTrue("Trusted Backend startup remained pending", start.isCompletedExceptionally)
        assertTrue("Trusted Backend was not closed", backend.closed.get())
    }

    @Test
    fun trustedInvocationSettlesAfterTheRuntimeBecomesIdle() {
        val backend = ProbeBackend()
        @Suppress("DEPRECATION")
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(),
            nativeHost = FailClosedRuntimeNativeHost(),
            trustedBackend = backend,
        )
        try {
            val start = engine.start()
            assertTrue("Trusted Backend did not start", backend.started.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertTrue("Runtime start completed before Backend readiness", !start.isDone)
            backend.ready.complete(Unit)
            start.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            backend.invokeAfterStart()
            assertTrue("Trusted Backend terminal did not settle", backend.settled.await(TIMEOUT_SECONDS, TimeUnit.SECONDS))
            assertEquals(
                "runtime.capability_unsupported",
                JSONObject(backend.terminal).getJSONObject("error").getString("code"),
            )
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    private class ProbeBackend : RuntimeTrustedBackend {
        private lateinit var host: RuntimeTrustedBackendHost
        val ready = CompletableFuture<Unit>()
        val started = CountDownLatch(1)
        val settled = CountDownLatch(1)
        val closed = AtomicBoolean(false)

        @Volatile
        var terminal: String = ""
            private set

        override fun start(host: RuntimeTrustedBackendHost): CompletableFuture<Unit> {
            this.host = host
            started.countDown()
            return ready
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            ready.completeExceptionally(IllegalStateException("Probe Backend closed before readiness"))
        }

        fun invokeAfterStart() {
            host.invoke(RuntimeTrustedBackendChannel.LINUX_FILESYSTEM, "{}") { value ->
                terminal = value
                settled.countDown()
            }
        }
    }

    private companion object {
        private const val TIMEOUT_SECONDS = 10L
    }
}
