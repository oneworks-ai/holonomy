package ai.oneworks.holonomy.e2e

import android.content.res.AssetManager
import android.os.Build
import android.os.SystemClock
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeImplementationStage
import ai.oneworks.holonomy.host.RuntimeMicrotaskMode
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.URI
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeCompositionInstrumentationTest {
    @Test
    fun testActualComposerInventoryPlanningEventLoopNativeTerminationAndDisposal() {
        val nativeHosts = Collections.synchronizedList(mutableListOf<FailClosedRuntimeNativeHost>())
        val assets = runtimeAssets()
        val externalModules = mapOf(
            "fixture+device://phone/modules/dependency.mjs" to
                "export const deviceValue = 'physical-compatible'",
        )
        val externalReferrers = Collections.synchronizedList(mutableListOf<String?>())
        val moduleResolver = RuntimeModuleResolver { specifier, referrerUrl ->
            externalReferrers += referrerUrl
            val resourceUrl = runCatching {
                val candidate = URI(specifier)
                if (candidate.isAbsolute) candidate else URI(requireNotNull(referrerUrl)).resolve(candidate)
            }.getOrNull()?.normalize()?.toString()
            resourceUrl?.let { resolved ->
                externalModules[resolved]?.let { RuntimeModuleSource(resolved, it) }
            }
        }
        val engine = RuntimeEngineFactory.create(
            assets,
            nativeHostFactory = {
                FailClosedRuntimeNativeHost().also(nativeHosts::add)
            },
            moduleResolver = moduleResolver,
        )
        try {
            engine.start().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(RuntimeImplementationStage.BOOTSTRAP, engine.capabilities.implementationStage)
            assertEquals(RuntimeMicrotaskMode.AUTO, engine.capabilities.microtaskMode)
            assertTrue(engine.capabilities.esmModules)
            assertFalse(engine.capabilities.inspectorEnabled)
            verifyAssetManifest(assets)
            verifyAssetManifest(assets)

            var state = inspectRuntime(engine)
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

            val rawHost = jsonRuntimeEvaluation(
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
                ).get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS),
            )
            for (key in listOf("dispatch", "host", "hostDispatch", "hostReadAsset", "readAsset", "turnDriver")) {
                assertEquals("undefined", rawHost.getString(key))
            }

            engine.evaluate("__oneworksHolonomy.exercisePlan()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitRuntimeState(engine, "module plan") {
                it.optJSONObject("plan")?.optString("phase") == "planned"
            }
            val plan = state.getJSONObject("plan")
            assertEquals("planned", plan.getString("phase"))
            val modules = plan.getJSONArray("modules")
            assertTrue(modules.toString().contains("node:path"))
            assertTrue(modules.toString().contains("synthetic"))

            engine.executeModule(
                RuntimeModuleSource(
                    resourceUrl = "fixture+device://phone/modules/entry.mjs",
                    source = """
                        import { join } from 'node:path'
                        import { deviceValue } from './dependency.mjs'
                        globalThis.__holonomyExternalModule = {
                          deviceValue,
                          importMetaUrl: import.meta.url,
                          joined: join('user', 'module')
                        }
                    """.trimIndent(),
                ),
            ).get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val externalModule = jsonRuntimeEvaluation(
                engine.evaluate("globalThis.__holonomyExternalModule")
                    .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS),
            )
            assertEquals("physical-compatible", externalModule.getString("deviceValue"))
            assertEquals(
                "fixture+device://phone/modules/entry.mjs",
                externalModule.getString("importMetaUrl"),
            )
            assertEquals("user/module", externalModule.getString("joined"))
            assertEquals(
                listOf("fixture+device://phone/modules/entry.mjs"),
                externalReferrers,
            )
            assertRuntimeFailsWithCode(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                engine.executeModule(
                    RuntimeModuleSource(
                        resourceUrl = "HoLoNoMy:///runtime/guest-entry.mjs",
                        source = "export const forbidden = true",
                    ),
                ),
            )
            assertRuntimeFailsWithCode(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                engine.executeModule(
                    RuntimeModuleSource(
                        resourceUrl = "fixture+device://phone/modules/reserved-import.mjs",
                        source = "import 'holonomy:///runtime/bootstrap.mjs'",
                    ),
                ),
            )

            engine.evaluate("__oneworksHolonomy.exerciseEventLoop()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitRuntimeState(engine, "host-driven event loop") {
                it.optJSONArray("eventOrder")?.length() == 3
            }
            assertEquals("[\"macrotask\",\"promise\",\"timer\"]", state.getJSONArray("eventOrder").toString())
            assertEquals("[\"macrotask\",\"timer\"]", state.getJSONArray("turnKinds").toString())

            engine.evaluate("__oneworksHolonomy.exerciseWakeupRearm()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitRuntimeState(engine, "cancelled and rearmed wakeups") {
                it.optJSONArray("wakeupOrder")?.length() == 2
            }
            assertEquals("[\"early\",\"late\"]", state.getJSONArray("wakeupOrder").toString())

            val nativeAdmission = jsonRuntimeEvaluation(
                engine.evaluate("__oneworksHolonomy.exerciseNativeCompletion()")
                    .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS),
            )
            assertEquals(1, nativeAdmission.getInt("beforeTurn"))
            state = awaitRuntimeState(engine, "native completion") {
                it.optJSONObject("native")?.optString("phase") == "rejected"
            }
            assertEquals("native-completion", state.getJSONArray("turnKinds").getString(4))
            val nativeError = state.getJSONObject("native").getJSONObject("error")
            assertEquals("capability_unsupported", nativeError.getString("code"))
            assertEquals("runtime", nativeError.getString("domain"))
            assertEquals("Native capability is not supported", nativeError.getString("message"))
            assertFalse(nativeError.toString().contains("must-not-cross-error-boundary"))
            assertEquals(1, nativeHosts.first().dispatchCount)
            assertFalse(nativeHosts.first().lastRequestJson.orEmpty().contains("authority"))
            assertTrue(nativeHosts.first().lastContextJson.orEmpty().contains("\"capabilities\":[]"))

            val blocked = engine.evaluate("while (true) {}")
            engine.terminate().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertRuntimeFailsWithCode(RuntimeEngineErrorCode.TERMINATED, blocked)
            engine.start().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals("ready", inspectRuntime(engine).getString("phase"))

            engine.evaluate("__oneworksHolonomy.exerciseFatalTermination()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            SystemClock.sleep(FATAL_UNWIND_WAIT_MS)
            engine.start().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals("ready", inspectRuntime(engine).getString("phase"))

            engine.evaluate("__oneworksHolonomy.dispose()")
                .get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            state = awaitRuntimeState(engine, "composer disposal") { it.optString("phase") == "disposed" }
            assertEquals("disposed", state.getString("phase"))
            assertEquals(
                "runtime_composer.disposed",
                state.getJSONObject("loaderAfterDispose").getString("code"),
            )
            val counters = state.getJSONObject("nativeBridge")
            for (
                key in listOf(
                    "inFlightBinaryBytes",
                    "inFlightBinaryHandles",
                    "openHandles",
                    "openResources",
                    "outstandingCredits",
                    "pendingRequests",
                )
            ) {
                assertEquals("$key must be zero", 0, counters.getInt(key))
            }

            val firstDispose = engine.dispose()
            assertSame(firstDispose, engine.dispose())
            firstDispose.get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            SystemClock.sleep(DISPOSE_RACE_WAIT_MS)
            assertEquals(1, nativeHosts.sumOf(FailClosedRuntimeNativeHost::dispatchCount))
            assertRuntimeFailsWithCode(RuntimeEngineErrorCode.DISPOSED, engine.evaluate("1 + 1"))
        } finally {
            engine.dispose().get(INSTRUMENTATION_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
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

    private fun assertJsonArrayEquals(expected: JSONArray, actual: JSONArray) {
        assertEquals(expected.toString(), actual.toString())
    }

    private companion object {
        private const val DISPOSE_RACE_WAIT_MS = 650L
        private const val FATAL_UNWIND_WAIT_MS = 150L
        private const val MANIFEST_PATH = "runtime/asset-manifest.json"
    }
}
