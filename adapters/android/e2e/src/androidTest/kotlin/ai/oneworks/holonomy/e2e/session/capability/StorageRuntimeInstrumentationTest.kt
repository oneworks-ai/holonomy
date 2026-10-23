package ai.oneworks.holonomy.e2e

import android.os.SystemClock
import android.system.Os
import android.util.Log
import ai.oneworks.holonomy.capability.AndroidCapabilityHost
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeCapabilityServices
import ai.oneworks.holonomy.host.RuntimeCapabilityServicesFactory
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.host.RuntimeProcessConfiguration
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.storage.AndroidStorageHostConfiguration
import ai.oneworks.holonomy.storage.AndroidStorageNativeHost
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class StorageRuntimeInstrumentationTest {
    @Test
    fun sharedKvCasesUseProductionBootstrapBrokerAndPersistentAndroidWorker() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fixture = JSONObject(instrumentation.context.assets.open("conformance/storage-kv-fixture.json")
            .bufferedReader().use { it.readText() })
        val root = File(instrumentation.targetContext.noBackupFilesDir, "storage-${UUID.randomUUID()}").apply { mkdirs() }.canonicalFile
        Os.chmod(root.path, 448)
        val generation = AtomicInteger()
        val output = CopyOnWriteArrayList<String>()
        val entryUrl = fixture.getString("entryUrl")
        val suiteUrl = fixture.getString("suiteUrl")
        val engine = RuntimeEngineFactory.create(
            assets = runtimeAssets(), bootstrapAssetPath = "runtime/production-bootstrap.mjs",
            nativeHostFactory = { FailClosedRuntimeNativeHost() },
            processHost = object : RuntimeProcessHost {
                override val configuration = RuntimeProcessConfiguration()
                override fun write(stream: RuntimeOutputStream, chunk: String) {
                    output += chunk
                    Log.i("HoloStorageBootstrap", chunk.take(4096))
                }
                override fun exit(code: Int) = Unit
            },
            capabilityServicesFactory = RuntimeCapabilityServicesFactory {
                val current = generation.incrementAndGet()
                val session = fixture.getJSONArray("configurations").getJSONObject(current - 1)
                RuntimeCapabilityServices(
                    capabilityHost = AndroidCapabilityHost(instrumentation.targetContext,
                        JSONObject().put("session", session).put("generation", current).toString(),
                        "android_storage_fixture", current.toLong(), "host.network"),
                    nativeHost = AndroidStorageNativeHost(AndroidStorageHostConfiguration(root,
                        "fixture", "android_storage_fixture", current.toLong())),
                )
            },
            moduleResolver = RuntimeModuleResolver { name, referrer ->
                val url = java.net.URI(referrer ?: entryUrl).resolve(name).toString()
                if (url == suiteUrl) RuntimeModuleSource(url, fixture.getString("suite")) else null
            },
        )
        try {
            repeat(2) { index ->
                output.clear()
                engine.start().get(30, TimeUnit.SECONDS)
                engine.evaluate("globalThis.__storageExpectedExisting = ${index > 0}").get(10, TimeUnit.SECONDS)
                engine.executeModule(RuntimeModuleSource(entryUrl, fixture.getString("entry"))).get(30, TimeUnit.SECONDS)
                val deadline = SystemClock.elapsedRealtime() + 30_000
                var summary: JSONObject? = null
                while (SystemClock.elapsedRealtime() < deadline && summary == null) {
                    val value = output.firstOrNull { it.contains("STORAGE_JS_SUMMARY:") }
                    if (value != null) summary = JSONObject(value.substringAfter("STORAGE_JS_SUMMARY:").trim())
                    else SystemClock.sleep(10)
                }
                val completed = requireNotNull(summary) { "Storage JS runner did not settle" }
                Log.i("HolonomyConformance", "STORAGE_JS_GENERATION_${index + 1}:$completed")
                assertEquals(completed.toString(), 0, completed.getInt("failed"))
                assertEquals(5, completed.getInt("total"))
                assertEquals(5, completed.getInt("passed"))
                if (index == 0) engine.terminate().get(30, TimeUnit.SECONDS)
            }
        } finally { engine.dispose().get(30, TimeUnit.SECONDS) }
    }
}
