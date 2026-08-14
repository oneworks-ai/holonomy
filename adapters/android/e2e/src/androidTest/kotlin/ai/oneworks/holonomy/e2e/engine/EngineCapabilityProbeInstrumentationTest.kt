package ai.oneworks.holonomy.e2e

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.V8ValueArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EngineCapabilityProbeInstrumentationTest {
    @Test
    fun testPackagedWasmBackendProbeCompilesAndExecutes() {
        val bytes = runtimeAssets().open("runtime/process-backends/probe-answer-v1.wasm").use { it.readBytes() }
        val manifest = JSONObject(
            runtimeAssets().open("runtime/asset-manifest.json")
                .use { it.readBytes().toString(Charsets.UTF_8) },
        )
        val entry = (0 until manifest.getJSONArray("assets").length())
            .map { manifest.getJSONArray("assets").getJSONObject(it) }
            .firstOrNull { it.getString("path") == "runtime/process-backends/probe-answer-v1.wasm" }
        assertNotNull(entry)
        assertEquals("backend-probe", entry!!.getString("kind"))
        assertFalse(entry.getBoolean("guestReadable"))

        val source = """
            const bytes = new Uint8Array([${bytes.joinToString(",") { (it.toInt() and 0xFF).toString() }}]);
            const module = new WebAssembly.Module(bytes);
            const instance = new WebAssembly.Instance(module);
            globalThis.__wasmBackendProbe = instance.exports.run();
        """.trimIndent()
        val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
        try {
            runtime.getExecutor(source).executeVoid()
            assertEquals(42, runtime.globalObject.getInteger("__wasmBackendProbe"))
        } finally {
            runtime.close()
        }
    }

    @Test
    fun testPrecompiledModuleExecutesAfterGenerationLevelStringGateCloses() {
        val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
        try {
            val module = runtime.getExecutor(
                "globalThis.__capabilityProbe = [typeof WebAssembly, " +
                    "(() => { try { eval('1'); return false } catch { return true } })(), " +
                    "(() => { try { Function('return 1')(); return false } catch { return true } })()]",
            ).setModule(true).setResourceName("app+local://probe/entry.mjs").compileV8Module()
            assertTrue(module.instantiate())
            runtime.allowEval(false)
            runtime.globalObject.delete("WebAssembly")
            module.evaluate<V8Value>(false).close()
            runtime.globalObject.get<V8ValueArray>("__capabilityProbe").use { result ->
                assertEquals("undefined", result.getString(0))
                assertTrue(result.getBoolean(1))
                assertTrue(result.getBoolean(2))
            }
        } finally {
            runtime.close()
        }
    }

    @Test
    fun testMachineDescriptorMatchesRealJavetCodeGenerationCapabilities() {
        val descriptor = JSONObject(
            runtimeAssets().open("android-engine-hook-capability-v1.json")
                .use { it.readBytes().toString(Charsets.UTF_8) },
        )
        assertEquals("android-embedded-v8", descriptor.getString("engine"))

        val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
        try {
            assertTrue(runCatching { runtime.getExecutor("eval('1')").executeVoid() }.isSuccess)
            assertTrue(runCatching { runtime.getExecutor("Function('return 1')()") .executeVoid() }.isSuccess)
            runtime.allowEval(false)
            assertTrue(runCatching { runtime.getExecutor("eval('1')").executeVoid() }.isFailure)
            assertTrue(runCatching { runtime.getExecutor("Function('return 1')()") .executeVoid() }.isFailure)
            assertTrue(
                runCatching {
                    runtime.getExecutor(
                        "new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))",
                    ).executeVoid()
                }.isSuccess,
            )
        } finally {
            runtime.close()
        }

        val strings = descriptor.getJSONObject("strings")
        assertTrue(strings.getBoolean("generationLevelDeny"))
        assertFalse(strings.getBoolean("perCompilationCallback"))
        val wasm = descriptor.getJSONObject("wasm")
        assertFalse(wasm.getBoolean("generationLevelDeny"))
        assertFalse(wasm.getBoolean("perCompilationCallback"))
        val metadata = descriptor.getJSONObject("metadata")
        for (name in listOf("callsite", "entryDetail", "origin", "source")) {
            assertEquals("unavailable", metadata.getString(name))
        }
        val provenance = descriptor.getJSONObject("provenance")
        assertEquals("behavioralProbe", provenance.getString("generationLevel"))
        assertEquals("profileStaticUnsupported", provenance.getString("metadata"))
        assertEquals("profileStaticUnsupported", provenance.getString("perCompilationCallback"))
    }
}
