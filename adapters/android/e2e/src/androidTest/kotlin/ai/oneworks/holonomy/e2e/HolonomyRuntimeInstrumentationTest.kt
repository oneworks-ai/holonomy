package ai.oneworks.holonomy.e2e

import android.content.res.AssetManager
import android.os.Build
import android.os.SystemClock
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeEngineException
import ai.oneworks.holonomy.host.RuntimeEvaluation
import ai.oneworks.holonomy.host.RuntimeImplementationStage
import ai.oneworks.holonomy.host.RuntimeMicrotaskMode
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HolonomyRuntimeInstrumentationTest {
    @Test
    fun testActualComposerInventoryPlanningEventLoopNativeTerminationAndDisposal() {
        val nativeHost = FailClosedRuntimeNativeHost()
        val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
        val engine = RuntimeEngineFactory.create(assets, nativeHost)
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(RuntimeImplementationStage.BOOTSTRAP, engine.capabilities.implementationStage)
            assertEquals(RuntimeMicrotaskMode.AUTO, engine.capabilities.microtaskMode)
            assertTrue(engine.capabilities.esmModules)
            assertFalse(engine.capabilities.inspectorEnabled)
            verifyAssetManifest(assets)

            var state = inspect(engine)
            assertEquals(state.toString(), "ready", state.getString("phase"))
            assertEquals(expectedRuntimeArchitecture(), state.getString("architecture"))
            assertJsonArrayEquals(state.getJSONArray("expectedModules"), state.getJSONArray("modules"))
            assertJsonArrayEquals(state.getJSONArray("expectedGlobals"), state.getJSONArray("globals"))
            val capabilityStatus = state.getJSONObject("capabilityStatus")
            assertEquals("installed", capabilityStatus.getString("node-core"))
            assertEquals("installed", capabilityStatus.getString("streams"))
            val unsupported = state.getJSONArray("optionalCapabilities")
            for (index in 0 until unsupported.length()) {
                assertEquals("unsupported", capabilityStatus.getString(unsupported.getString(index)))
            }

            val rawHost = jsonEvaluation(
                engine.evaluate(
                    """
                    ({
                      dispatch: typeof globalThis.dispatch,
                      host: typeof globalThis.__oneworksAndroidHost,
                      hostDispatch: typeof globalThis.__oneworksAndroidHost?.dispatch,
                      hostReadAsset: typeof globalThis.__oneworksAndroidHost?.readAsset,
                      readAsset: typeof globalThis.readAsset,
                      turnDriver: typeof globalThis.__oneworksAndroidTurn
                    })
                    """.trimIndent(),
                ).get(TIMEOUT_SECONDS, TimeUnit.SECONDS),
            )
            for (key in listOf("dispatch", "host", "hostDispatch", "hostReadAsset", "readAsset", "turnDriver")) {
                assertEquals("undefined", rawHost.getString(key))
            }

            engine.evaluate("__oneworksHolonomy.exercisePlan()").get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitState(engine, "module plan") { it.optJSONObject("plan")?.optString("phase") == "planned" }
            val plan = state.getJSONObject("plan")
            assertEquals("planned", plan.getString("phase"))
            val modules = plan.getJSONArray("modules")
            assertTrue(modules.toString().contains("node:path"))
            assertTrue(modules.toString().contains("synthetic"))

            engine.evaluate("__oneworksHolonomy.exerciseEventLoop()")
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitState(engine, "host-driven event loop") {
                it.optJSONArray("eventOrder")?.length() == 3
            }
            assertEquals("[\"macrotask\",\"promise\",\"timer\"]", state.getJSONArray("eventOrder").toString())
            assertEquals("[\"macrotask\",\"timer\"]", state.getJSONArray("turnKinds").toString())

            engine.evaluate("__oneworksHolonomy.exerciseWakeupRearm()")
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitState(engine, "cancelled and rearmed wakeups") {
                it.optJSONArray("wakeupOrder")?.length() == 2
            }
            assertEquals("[\"early\",\"late\"]", state.getJSONArray("wakeupOrder").toString())

            val nativeAdmission = jsonEvaluation(
                engine.evaluate("__oneworksHolonomy.exerciseNativeCompletion()")
                    .get(TIMEOUT_SECONDS, TimeUnit.SECONDS),
            )
            assertEquals(1, nativeAdmission.getInt("beforeTurn"))
            state = awaitState(engine, "native completion") {
                it.optJSONObject("native")?.optString("phase") == "rejected"
            }
            assertEquals("native-completion", state.getJSONArray("turnKinds").getString(4))
            val nativeError = state.getJSONObject("native").getJSONObject("error")
            assertEquals("capability_unsupported", nativeError.getString("code"))
            assertEquals("runtime", nativeError.getString("domain"))
            assertEquals("Native capability is not supported", nativeError.getString("message"))
            assertFalse(nativeError.toString().contains("must-not-cross-error-boundary"))
            assertEquals(1, nativeHost.dispatchCount)
            assertFalse(nativeHost.lastRequestJson.orEmpty().contains("authority"))
            assertTrue(nativeHost.lastContextJson.orEmpty().contains("\"capabilities\":[]"))

            val blocked = engine.evaluate("while (true) {}")
            engine.terminate().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertFailsWithCode(RuntimeEngineErrorCode.TERMINATED, blocked)
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals("ready", inspect(engine).getString("phase"))

            engine.evaluate("__oneworksHolonomy.exerciseFatalTermination()")
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            SystemClock.sleep(FATAL_UNWIND_WAIT_MS)
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals("ready", inspect(engine).getString("phase"))

            engine.evaluate("__oneworksHolonomy.dispose()")
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitState(engine, "composer disposal") { it.optString("phase") == "disposed" }
            assertEquals("disposed", state.getString("phase"))
            assertEquals(
                "runtime_composer.disposed",
                state.getJSONObject("loaderAfterDispose").getString("code"),
            )
            val counters = state.getJSONObject("nativeBridge")
            for (key in listOf(
                "inFlightBinaryBytes",
                "inFlightBinaryHandles",
                "openHandles",
                "openResources",
                "outstandingCredits",
                "pendingRequests",
            )) {
                assertEquals("$key must be zero", 0, counters.getInt(key))
            }

            val firstDispose = engine.dispose()
            assertSame(firstDispose, engine.dispose())
            firstDispose.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            SystemClock.sleep(DISPOSE_RACE_WAIT_MS)
            assertEquals(1, nativeHost.dispatchCount)
            assertFailsWithCode(RuntimeEngineErrorCode.DISPOSED, engine.evaluate("1 + 1"))
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    private fun inspect(engine: ai.oneworks.holonomy.host.RuntimeEngine): JSONObject =
        jsonEvaluation(
            engine.evaluate("__oneworksHolonomy.inspect()")
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS),
        )

    private fun awaitState(
        engine: ai.oneworks.holonomy.host.RuntimeEngine,
        description: String,
        predicate: (JSONObject) -> Boolean,
    ): JSONObject {
        val deadline = SystemClock.elapsedRealtime() + TimeUnit.SECONDS.toMillis(TIMEOUT_SECONDS)
        var state = inspect(engine)
        while (!predicate(state) && SystemClock.elapsedRealtime() < deadline) {
            SystemClock.sleep(POLL_INTERVAL_MS)
            state = inspect(engine)
        }
        assertTrue("Timed out waiting for $description: $state", predicate(state))
        return state
    }

    private fun verifyAssetManifest(assets: AssetManager) {
        val manifest = JSONObject(assets.open(MANIFEST_PATH).use { it.readBytes().toString(Charsets.UTF_8) })
        assertEquals(2, manifest.getInt("schemaVersion"))
        assertTrue(manifest.getJSONArray("typescriptSources").length() > 0)
        val entries = manifest.getJSONArray("assets")
        val expected = mutableSetOf(MANIFEST_PATH)
        val guestReadable = mutableSetOf<String>()
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            val path = entry.getString("path")
            expected += path
            val bytes = assets.open(path).use { it.readBytes() }
            assertEquals(entry.getString("sha256"), sha256(bytes))
            if (entry.optBoolean("guestReadable", false)) guestReadable += path
        }
        assertEquals(setOf("runtime/fixtures/managed-plugin.mjs"), guestReadable)
        assertEquals(expected, listAssetFiles(assets, "runtime").toSet())
    }

    private fun listAssetFiles(assets: AssetManager, root: String): List<String> {
        val children = assets.list(root).orEmpty()
        return if (children.isEmpty()) listOf(root) else children.flatMap { listAssetFiles(assets, "$root/$it") }
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun expectedRuntimeArchitecture(): String = when (Build.SUPPORTED_ABIS.first()) {
        "arm64-v8a" -> "arm64"
        "x86_64" -> "x64"
        else -> throw AssertionError("Unexpected packaged ABI ${Build.SUPPORTED_ABIS.first()}")
    }

    private fun jsonEvaluation(evaluation: RuntimeEvaluation): JSONObject {
        assertEquals(RuntimeEvaluation.Kind.JSON, evaluation.kind)
        return JSONObject(evaluation.value!!)
    }

    private fun assertJsonArrayEquals(expected: JSONArray, actual: JSONArray) {
        assertEquals(expected.toString(), actual.toString())
    }

    private fun assertFailsWithCode(
        expectedCode: RuntimeEngineErrorCode,
        future: java.util.concurrent.CompletableFuture<*>,
    ) {
        try {
            future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            fail("Expected runtime operation to fail with ${expectedCode.stableCode}")
        } catch (error: ExecutionException) {
            val runtimeError = error.cause as RuntimeEngineException
            assertEquals(expectedCode, runtimeError.code)
        }
    }

    private companion object {
        private const val DISPOSE_RACE_WAIT_MS = 650L
        private const val FATAL_UNWIND_WAIT_MS = 150L
        private const val MANIFEST_PATH = "runtime/asset-manifest.json"
        private const val POLL_INTERVAL_MS = 10L
        private const val TIMEOUT_SECONDS = 20L
    }
}
