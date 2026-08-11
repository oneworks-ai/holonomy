package ai.oneworks.holonomy.e2e

import android.os.SystemClock
import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativePortTransportInstrumentationTest {
    @Test
    fun testNativeTransportSnapshotsProviderBinaryAndClosesHostOnce() {
        val closeCount = AtomicInteger()
        val nativeHost = object : RuntimeNativeHost {
            override fun dispatch(
                requestId: String,
                requestJson: String,
                contextJson: String,
                binary: List<RuntimeNativeBinary>,
                sink: RuntimeNativeEventSink,
                resourceSink: RuntimeNativeResourceEventSink,
            ) {
                val data = byteArrayOf(1, 2, 3)
                val output = mutableListOf(RuntimeNativeBinary("snapshot:0", data))
                sink.emit(
                    RuntimeNativeEvent(
                        JSONObject().put("id", requestId).put("type", "result")
                            .put("value", JSONObject().put("ok", true)).toString(),
                        output,
                    ),
                )
                data.fill(9)
                output.clear()
            }

            override fun close() {
                closeCount.incrementAndGet()
            }
        }
        val engine = RuntimeEngineFactory.create(runtimeAssets(), nativeHost)
        try {
            engine.start().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.evaluate("__oneworksHolonomy.exerciseNativeBinarySnapshot()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val state = awaitRuntimeState(engine, "native binary snapshot") {
                it.optJSONObject("nativeBinary")?.optString("phase") == "resolved"
            }
            assertEquals("[1,2,3]", state.getJSONObject("nativeBinary").getJSONArray("bytes").toString())
            engine.evaluate("__oneworksHolonomy.dispose()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            awaitRuntimeState(engine, "native host disposal") { it.optString("phase") == "disposed" }
            engine.dispose().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(1, closeCount.get())
        } finally {
            engine.dispose().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Test
    fun testMalformedNativeResourceEventTerminatesTransport() {
        verifyMalformedResourceEvent("not-json")
    }

    @Test
    fun testOversizedNativeResourceEventTerminatesTransport() {
        verifyMalformedResourceEvent(" ".repeat(256 * 1024 + 1))
    }

    private fun verifyMalformedResourceEvent(eventJson: String) {
        val closeCount = AtomicInteger()
        val nativeHost = object : RuntimeNativeHost {
            override fun dispatch(
                requestId: String,
                requestJson: String,
                contextJson: String,
                binary: List<RuntimeNativeBinary>,
                sink: RuntimeNativeEventSink,
                resourceSink: RuntimeNativeResourceEventSink,
            ) {
                sink.emit(
                    RuntimeNativeEvent(
                        JSONObject().put("id", requestId).put("type", "result")
                            .put(
                                "resources",
                                JSONArray().put(
                                    JSONObject().put("providerToken", "snapshot:resource")
                                        .put("type", "snapshot.resource"),
                                ),
                            )
                            .put("value", JSONObject().put("ok", true)).toString(),
                    ),
                )
                resourceSink.emit(eventJson)
            }

            override fun close() {
                closeCount.incrementAndGet()
            }
        }
        val engine = RuntimeEngineFactory.create(runtimeAssets(), nativeHost)
        try {
            engine.start().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.evaluate("__oneworksHolonomy.exerciseNativeResourceTransport()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val deadline = SystemClock.elapsedRealtime() +
                TimeUnit.SECONDS.toMillis(INSTRUMENTATION_TIMEOUT_SECONDS)
            while (closeCount.get() == 0 && SystemClock.elapsedRealtime() < deadline) {
                SystemClock.sleep(INSTRUMENTATION_POLL_INTERVAL_MS)
            }
            assertEquals("Malformed resource transport must close its native host once", 1, closeCount.get())
        } finally {
            engine.dispose().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }
}
