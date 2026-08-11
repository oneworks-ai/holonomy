package ai.oneworks.holonomy.e2e

import android.content.res.AssetManager
import android.os.SystemClock
import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeEngineException
import ai.oneworks.holonomy.host.RuntimeEvaluation
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail

internal const val INSTRUMENTATION_POLL_INTERVAL_MS = 10L
internal const val INSTRUMENTATION_TIMEOUT_SECONDS = 20L

internal fun runtimeAssets(): AssetManager =
    InstrumentationRegistry.getInstrumentation().targetContext.assets

internal fun inspectRuntime(engine: RuntimeEngine): JSONObject =
    jsonRuntimeEvaluation(
        engine.evaluate("__oneworksHolonomy.inspect()")
            .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS),
    )

internal fun awaitRuntimeState(
    engine: RuntimeEngine,
    description: String,
    predicate: (JSONObject) -> Boolean,
): JSONObject {
    val deadline = SystemClock.elapsedRealtime() + TimeUnit.SECONDS.toMillis(INSTRUMENTATION_TIMEOUT_SECONDS)
    var state = inspectRuntime(engine)
    while (!predicate(state) && SystemClock.elapsedRealtime() < deadline) {
        SystemClock.sleep(INSTRUMENTATION_POLL_INTERVAL_MS)
        state = inspectRuntime(engine)
    }
    assertTrue("Timed out waiting for $description: $state", predicate(state))
    return state
}

internal fun jsonRuntimeEvaluation(evaluation: RuntimeEvaluation): JSONObject {
    assertEquals(RuntimeEvaluation.Kind.JSON, evaluation.kind)
    return JSONObject(evaluation.value!!)
}

internal fun assertRuntimeFailsWithCode(
    expectedCode: RuntimeEngineErrorCode,
    future: CompletableFuture<*>,
) {
    try {
        future.get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        fail("Expected runtime operation to fail with ${expectedCode.stableCode}")
    } catch (error: ExecutionException) {
        val runtimeError = error.cause as RuntimeEngineException
        assertEquals(expectedCode, runtimeError.code)
    }
}
