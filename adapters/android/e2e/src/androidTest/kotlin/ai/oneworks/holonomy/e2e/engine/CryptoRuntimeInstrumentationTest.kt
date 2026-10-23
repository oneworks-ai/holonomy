package ai.oneworks.holonomy.e2e

import android.os.SystemClock
import android.util.Log
import ai.oneworks.holonomy.crypto.AndroidRuntimeCryptoHost
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CryptoRuntimeInstrumentationTest {
    @Test
    fun sharedCryptoCasesRunThroughJcaAndSurviveFreshGeneration() {
        val suite = InstrumentationRegistry.getInstrumentation().context.assets
            .open("conformance/crypto-v1.test.mjs").bufferedReader().use { it.readText() }
        val entry = """
            import './suite.mjs';
            import { run } from 'node:test';
            globalThis.__cryptoSummary = await run();
        """.trimIndent()
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(),
            nativeHostFactory = { FailClosedRuntimeNativeHost() },
            cryptoHostFactory = { AndroidRuntimeCryptoHost() },
            moduleResolver = RuntimeModuleResolver { name, referrer ->
                val url = java.net.URI(referrer ?: ENTRY).resolve(name).toString()
                if (url == SUITE) RuntimeModuleSource(SUITE, suite) else null
            },
        )
        try {
            repeat(2) { generation ->
                engine.start().get(30, TimeUnit.SECONDS)
                engine.executeModule(RuntimeModuleSource(ENTRY, entry)).get(30, TimeUnit.SECONDS)
                val deadline = SystemClock.elapsedRealtime() + 30_000
                var summary: JSONObject? = null
                while (SystemClock.elapsedRealtime() < deadline && summary == null) {
                    val value = jsonRuntimeEvaluation(engine.evaluate(
                        "globalThis.__cryptoSummary ?? {}",
                    ).get(10, TimeUnit.SECONDS))
                    if (value is JSONObject && value.has("total")) summary = value
                    else SystemClock.sleep(10)
                }
                val completed = requireNotNull(summary) { "Shared Crypto runner did not settle" }
                Log.i("HolonomyConformance", "CRYPTO_JS_GENERATION_${generation + 1}:$completed")
                assertEquals(completed.toString(), 0, completed.getInt("failed"))
                assertEquals(6, completed.getInt("total"))
                assertEquals(6, completed.getInt("passed"))
                engine.terminate().get(30, TimeUnit.SECONDS)
            }
        } finally { engine.dispose().get(30, TimeUnit.SECONDS) }
    }

    private companion object {
        const val ENTRY = "fixture+crypto://runtime/entry.mjs"
        const val SUITE = "fixture+crypto://runtime/suite.mjs"
    }
}
