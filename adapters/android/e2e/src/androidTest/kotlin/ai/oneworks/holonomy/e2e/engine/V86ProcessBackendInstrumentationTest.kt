package ai.oneworks.holonomy.e2e

import android.os.Debug
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.interop.options.V8RuntimeOptions
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValueObject
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class V86ProcessBackendInstrumentationTest {
    @Test
    fun testPackagedV86BootsLinuxAndRunsSupervisorProcess() {
        val assets = runtimeAssets()
        assumeTrue(
            "The optional digest-bound v86 probe assets were not packaged",
            assets.list(V86_ROOT).orEmpty().contains("v86.wasm"),
        )
        val manifest = JSONObject(
            assets.open("runtime/asset-manifest.json").use { it.readBytes().toString(Charsets.UTF_8) },
        )
        V8RuntimeOptions.V8_FLAGS.setCustomFlags(
            "--liftoff-only --no-wasm-tier-up --no-wasm-dynamic-tiering --wasm-num-compilation-tasks=1",
        )
        val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
        val startedAt = SystemClock.elapsedRealtime()
        val initialPssKb = Debug.getPss()
        try {
            runtime.getExecutor(readVerifiedAsset(manifest, "$V86_ROOT/probe-shim.mjs").toString(Charsets.UTF_8))
                .executeVoid()
            runtime.getExecutor(readVerifiedAsset(manifest, "$V86_ROOT/fuse-probe.mjs").toString(Charsets.UTF_8))
                .executeVoid()
            runtime.getExecutor(readVerifiedAsset(manifest, "$V86_ROOT/probe.mjs").toString(Charsets.UTF_8))
                .executeVoid()
            installBuffer(runtime, "__holoV86Wasm", readVerifiedAsset(manifest, "$V86_ROOT/v86.wasm"))
            installBuffer(runtime, "__holoV86Bios", readVerifiedAsset(manifest, "$V86_ROOT/seabios.bin"))
            installBuffer(runtime, "__holoV86Kernel", readVerifiedAsset(manifest, "$V86_ROOT/kernel.bin"))
            installBuffer(runtime, "__holoV86Initrd", readVerifiedAsset(manifest, "$V86_ROOT/supervisor.cpio"))

            val library = readVerifiedAsset(manifest, "$V86_ROOT/libv86.mjs").toString(Charsets.UTF_8)
            val module = runtime.getExecutor(library)
                .setModule(true)
                .setResourceName("holonomy:///runtime/process-backends/v86/libv86.mjs")
                .compileV8Module()
            try {
                assertTrue(module.instantiate())
                module.evaluate<V8Value>(false).close()
                runtime.await(V8AwaitMode.RunTillNoMoreTasks)
                val namespace = module.namespace as V8ValueObject
                namespace.use {
                    it.get<V8ValueFunction>("V86").use { constructor ->
                        runtime.globalObject.get<V8ValueFunction>("__holoStartV86Probe").use { start ->
                            start.callVoid(runtime.globalObject, constructor)
                        }
                    }
                }
                awaitProbe(runtime)
            } finally {
                module.close()
            }

            val result = JSONObject(runtime.globalObject.getString("__holoV86ProbeResult"))
            assertEquals(7, result.getInt("code"))
            assertEquals(0, result.getInt("fuseCode"))
            assertEquals("FUSE_INPUT:HOST_TO_GUEST", result.getString("fuseStdout"))
            assertEquals("GUEST_TO_HOST", result.getString("fuseOutput"))
            assertTrue(result.getInt("fuseEvents") >= 6)
            assertTrue(result.getInt("fuseLinuxPid") > 0)
            assertTrue(result.getInt("fuseProcessId") > 0)
            assertEquals("REAL_STDOUT:android-input\n", result.getString("stdout"))
            assertEquals("REAL_STDERR\n", result.getString("stderr"))
            val elapsedMs = SystemClock.elapsedRealtime() - startedAt
            val pssDeltaKb = Debug.getPss() - initialPssKb
            assertTrue("v86 boot exceeded the emulator probe deadline: $elapsedMs ms", elapsedMs < TIMEOUT_MS)
            assertTrue("v86 probe PSS delta was invalid: $pssDeltaKb KiB", pssDeltaKb > 0)
            Log.i(
                "HolonomyV86Probe",
                JSONObject()
                    .put("bootDurationMs", result.getLong("bootDurationMs"))
                    .put("elapsedMs", elapsedMs)
                    .put("pssDeltaBytes", pssDeltaKb * 1024L)
                    .put("workloadDurationMs", result.getLong("workloadDurationMs"))
                    .toString(),
            )
            runtime.getExecutor("void globalThis.__holoV86ProbeVm.destroy()").executeVoid()
        } finally {
            runtime.close()
        }
    }

    private fun awaitProbe(runtime: V8Runtime) {
        val deadline = SystemClock.elapsedRealtime() + TIMEOUT_MS
        runtime.globalObject.get<V8ValueFunction>("__holoRunV86Timers").use { tick ->
            while (
                !runtime.globalObject.hasOwnProperty("__holoV86ProbeResult") &&
                SystemClock.elapsedRealtime() < deadline
            ) {
                tick.callInteger(runtime.globalObject)
                runtime.await(V8AwaitMode.RunNoWait)
                SystemClock.sleep(1)
            }
        }
        assertTrue("Timed out waiting for the v86 Linux supervisor", runtime.globalObject.hasOwnProperty("__holoV86ProbeResult"))
    }

    private fun installBuffer(runtime: V8Runtime, name: String, bytes: ByteArray) {
        runtime.createV8ValueArrayBuffer(bytes.size).use { buffer ->
            assertTrue(buffer.fromBytes(bytes))
            assertTrue(runtime.globalObject.set(name, buffer))
        }
    }

    private fun readVerifiedAsset(manifest: JSONObject, path: String): ByteArray {
        val entries = manifest.getJSONArray("assets")
        val entry = (0 until entries.length())
            .map { entries.getJSONObject(it) }
            .first { it.getString("path") == path }
        assertEquals("backend-probe", entry.getString("kind"))
        assertEquals(false, entry.getBoolean("guestReadable"))
        val value = runtimeAssets().open(path).use { it.readBytes() }
        val digest = MessageDigest.getInstance("SHA-256").digest(value)
            .joinToString("") { byte -> "%02x".format(byte) }
        assertEquals(entry.getString("sha256"), digest)
        return value
    }

    private companion object {
        private const val V86_ROOT = "runtime/process-backends/v86"
        private val TIMEOUT_MS = TimeUnit.MINUTES.toMillis(2)
    }
}
