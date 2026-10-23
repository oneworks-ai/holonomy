package ai.oneworks.holonomy.sdk.consumer

import android.os.SystemClock
import android.util.Log
import ai.oneworks.holonomy.crypto.AndroidRuntimeCryptoHost
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.host.RuntimeProcessConfiguration
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EmbeddedRuntimeTest {
    @Test
    fun productionAarsRunSharedJavaScriptWithoutE2eAssets() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val suite = instrumentation.context.assets.open("crypto-v1.test.mjs")
            .bufferedReader().use { it.readText() }
        val output = CopyOnWriteArrayList<String>()
        val entryUrl = "app://consumer/entry.mjs"
        val suiteUrl = "app://consumer/suite.mjs"
        val engine = RuntimeEngineFactory.create(
            assets = instrumentation.targetContext.assets,
            nativeHostFactory = { FailClosedRuntimeNativeHost() },
            cryptoHostFactory = { AndroidRuntimeCryptoHost() },
            processHost = object : RuntimeProcessHost {
                override val configuration = RuntimeProcessConfiguration()
                override fun write(stream: RuntimeOutputStream, chunk: String) {
                    output += chunk
                    Log.i("HoloSdkConsumer", chunk.take(4096))
                }
                override fun exit(code: Int) = Unit
            },
            moduleResolver = RuntimeModuleResolver { name, referrer ->
                val url = java.net.URI(referrer ?: entryUrl).resolve(name).toString()
                if (url == suiteUrl) RuntimeModuleSource(suiteUrl, suite) else null
            },
        )
        try {
            engine.start().get(30, TimeUnit.SECONDS)
            engine.executeModule(RuntimeModuleSource(entryUrl, """
                import './suite.mjs';
                import { run } from 'node:test';
                console.log('SDK_CONSUMER_JS:' + JSON.stringify(await run()));
            """.trimIndent())).get(30, TimeUnit.SECONDS)
            val deadline = SystemClock.elapsedRealtime() + 30000
            while (output.none { it.contains("SDK_CONSUMER_JS:") } &&
                SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(10)
            val line = requireNotNull(output.firstOrNull { it.contains("SDK_CONSUMER_JS:") })
            val summary = JSONObject(line.substringAfter("SDK_CONSUMER_JS:").trim())
            assertEquals(summary.toString(), 6, summary.getInt("passed"))
            assertEquals(0, summary.getInt("failed"))
            assertEquals(6, summary.getInt("total"))
        } finally {
            engine.dispose().get(30, TimeUnit.SECONDS)
        }
    }
}
