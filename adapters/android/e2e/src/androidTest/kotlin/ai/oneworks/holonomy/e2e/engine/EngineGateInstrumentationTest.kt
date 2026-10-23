package ai.oneworks.holonomy.e2e.engine

import ai.oneworks.holonomy.e2e.runtimeAssets
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeEngineCodeKind
import ai.oneworks.holonomy.host.RuntimeEngineGate
import ai.oneworks.holonomy.host.RuntimeEngineGateDecision
import ai.oneworks.holonomy.host.RuntimeEngineGateRequest
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.host.RuntimeProcessConfiguration
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.Collections
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EngineGateInstrumentationTest {
    @Test
    fun routesEvalThroughThePinnedNativeV8Callback() {
        val requests = Collections.synchronizedList(mutableListOf<RuntimeEngineGateRequest>())
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(),
            nativeHostFactory = ::FailClosedRuntimeNativeHost,
            engineGateFactory = {
                RuntimeEngineGate { request ->
                    requests += request
                    RuntimeEngineGateDecision.Allow
                }
            },
        )
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            requests.clear()
            engine.executeModule(
                RuntimeModuleSource(
                    "app+local://m4/eval-allowed.mjs",
                    "globalThis.__m4Eval = eval('40 + 2')",
                ),
            ).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

            assertEquals(1, requests.size)
            val request = requests.single()
            assertEquals(RuntimeEngineCodeKind.STRINGS, request.codeKind)
            assertEquals("40 + 2", request.copySource(1024).toString(Charsets.UTF_8))
            assertEquals(6, request.sourceBytes)
            assertTrue(request.sourceSha256.matches(Regex("[0-9a-f]{64}")))
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Test
    fun deniesStringAndWasmCompilationBeforeGeneratedCodeExecutes() {
        val requests = Collections.synchronizedList(mutableListOf<RuntimeEngineGateRequest>())
        val processHost = RecordingProcessHost()
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(),
            nativeHostFactory = ::FailClosedRuntimeNativeHost,
            processHost = processHost,
            engineGateFactory = {
                RuntimeEngineGate { request ->
                    requests += request
                    RuntimeEngineGateDecision.deny("test.denied")
                }
            },
        )
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            requests.clear()
            engine.executeModule(
                RuntimeModuleSource(
                    "app+local://m4/eval-denied.mjs",
                    "globalThis.__m4EvalExecuted=false;" +
                        "try{eval('globalThis.__m4EvalExecuted=true')}catch{};" +
                        "console.log('M4_EVAL_EXECUTED:'+globalThis.__m4EvalExecuted)",
                ),
            ).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(listOf(RuntimeEngineCodeKind.STRINGS), requests.map(RuntimeEngineGateRequest::codeKind))
            assertTrue(processHost.stdout.any { it.contains("M4_EVAL_EXECUTED:false") })

            requests.clear()
            engine.executeModule(
                RuntimeModuleSource(
                    "app+local://m4/wasm-denied.mjs",
                    "globalThis.__m4WasmCompiled=false;try{" +
                        "new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));" +
                        "globalThis.__m4WasmCompiled=true}catch{};" +
                        "console.log('M4_WASM_COMPILED:'+globalThis.__m4WasmCompiled)",
                ),
            ).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            assertEquals(listOf(RuntimeEngineCodeKind.WASM), requests.map(RuntimeEngineGateRequest::codeKind))
            assertTrue(processHost.stdout.any { it.contains("M4_WASM_COMPILED:false") })
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
    }

    @Test
    fun restartClosesTheOldGateAndBindsAFreshGeneration() {
        val gates = Collections.synchronizedList(mutableListOf<RecordingGate>())
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(),
            nativeHostFactory = ::FailClosedRuntimeNativeHost,
            engineGateFactory = {
                RecordingGate().also(gates::add)
            },
        )
        try {
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.executeModule(
                RuntimeModuleSource(
                    "app+local://m4/generation-one.mjs",
                    "globalThis.__m4GenerationOne = eval('20 + 1')",
                ),
            ).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            val first = gates.single()
            assertEquals(1, first.requests.size)

            engine.terminate().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.start().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
            engine.executeModule(
                RuntimeModuleSource(
                    "app+local://m4/generation-two.mjs",
                    "globalThis.__m4GenerationTwo = eval('20 + 2')",
                ),
            ).get(TIMEOUT_SECONDS, TimeUnit.SECONDS)

            assertEquals(2, gates.size)
            val second = gates.last()
            assertNotSame(first, second)
            assertEquals(1, first.closeCount.get())
            assertEquals(1, first.requests.size)
            assertEquals(1, second.requests.size)
        } finally {
            engine.dispose().get(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }
        assertEquals(listOf(1, 1), gates.map { it.closeCount.get() })
    }

    private companion object {
        private const val TIMEOUT_SECONDS = 15L
    }

    private class RecordingProcessHost : RuntimeProcessHost {
        override val configuration = RuntimeProcessConfiguration()
        val stdout = Collections.synchronizedList(mutableListOf<String>())

        override fun write(stream: RuntimeOutputStream, chunk: String) {
            if (stream == RuntimeOutputStream.STDOUT) stdout += chunk
        }

        override fun exit(code: Int) = Unit
    }

    private class RecordingGate : RuntimeEngineGate {
        val closeCount = AtomicInteger()
        val requests = Collections.synchronizedList(mutableListOf<RuntimeEngineGateRequest>())

        override fun decide(request: RuntimeEngineGateRequest): RuntimeEngineGateDecision {
            requests += request
            return RuntimeEngineGateDecision.Allow
        }

        override fun close() {
            closeCount.incrementAndGet()
        }
    }
}
