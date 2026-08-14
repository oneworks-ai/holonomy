package ai.oneworks.holonomy.e2e

import android.content.res.AssetManager
import android.os.SystemClock
import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.RuntimeTrustedBackendChannel
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValueObject
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/** E2E Backend that joins a real v86 FUSE frame to the production trusted Runtime channel. */
internal class V86TrustedBackendProbe(
    private val assets: AssetManager,
    private val runtimeId: String,
    private val generation: Long,
) : RuntimeTrustedBackend {
    private val closed = AtomicBoolean(false)
    private val terminals = ConcurrentLinkedQueue<TrustedBackendTerminal>()
    private val deliveredTerminals = AtomicInteger(0)
    private val pendingRequests = AtomicInteger(0)
    private val receivedTerminals = AtomicInteger(0)
    private val started = AtomicBoolean(false)
    private val worker = AtomicReference<Thread?>()
    private lateinit var host: RuntimeTrustedBackendHost

    override fun start(host: RuntimeTrustedBackendHost) {
        check(started.compareAndSet(false, true)) { "v86 trusted Backend already started" }
        this.host = host
        Thread(::runProbe, "holonomy-v86-$runtimeId-$generation").also { thread ->
            worker.set(thread)
            thread.start()
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        if (::host.isInitialized) {
            host.invoke(
                RuntimeTrustedBackendChannel.LINUX_FILESYSTEM,
                staleProbeRequest().toString(),
            ) { terminal -> E2eTrustedBackendEvidence.closed(runtimeId, generation, terminal) }
        }
        worker.get()?.let { thread ->
            if (thread !== Thread.currentThread()) {
                thread.join(WORKER_CLOSE_TIMEOUT_MS)
                check(!thread.isAlive) { "v86 trusted Backend did not close" }
            }
        }
    }

    private fun runProbe() {
        var runtime: V8Runtime? = null
        try {
            V86TrustedBackendNetworkProbe().use { network ->
                val manifest = manifest()
            val shim = readVerifiedAsset(manifest, "$V86_ROOT/probe-shim.mjs").toString(Charsets.UTF_8)
            val fuse = readVerifiedAsset(manifest, "$V86_ROOT/fuse-probe.mjs").toString(Charsets.UTF_8)
            val probe = readVerifiedAsset(manifest, "$V86_ROOT/trusted-backend-probe.mjs").toString(Charsets.UTF_8)
            val library = readVerifiedAsset(manifest, "$V86_ROOT/libv86.mjs").toString(Charsets.UTF_8)
            seedWorkspace()
            runtime = V8Host.getV8Instance().createV8Runtime()
            try {
                runtime.getExecutor(shim).executeVoid()
                runtime.getExecutor(fuse).executeVoid()
                runtime.getExecutor(probe).executeVoid()
                installBuffer(runtime, "__holoV86Wasm", readVerifiedAsset(manifest, "$V86_ROOT/v86.wasm"))
                installBuffer(runtime, "__holoV86Bios", readVerifiedAsset(manifest, "$V86_ROOT/seabios.bin"))
                installBuffer(runtime, "__holoV86Kernel", readVerifiedAsset(manifest, "$V86_ROOT/kernel.bin"))
                installBuffer(runtime, "__holoV86Initrd", readVerifiedAsset(manifest, "$V86_ROOT/supervisor.cpio"))
                val module = runtime.getExecutor(library)
                    .setModule(true)
                    .setResourceName("holonomy:///runtime/process-backends/v86/libv86.mjs")
                    .compileV8Module()
                try {
                    check(module.instantiate()) { "v86 module could not be instantiated" }
                    module.evaluate<V8Value>(false).close()
                    runtime.await(V8AwaitMode.RunTillNoMoreTasks)
                    (module.namespace as V8ValueObject).use { namespace ->
                        namespace.get<V8ValueFunction>("V86").use { constructor ->
                            runtime.globalObject.get<V8ValueFunction>(START_GLOBAL).use { start ->
                                start.callVoid(runtime.globalObject, constructor, configuration().toString())
                            }
                        }
                    }
                    awaitResult(runtime, network)
                } finally {
                    module.close()
                }
            } finally {
                runCatching {
                    if (runtime.globalObject.hasOwnProperty(VM_GLOBAL)) {
                        runtime.getExecutor("void globalThis.$VM_GLOBAL.destroy()").executeVoid()
                    }
                }
            }
            }
        } catch (error: Throwable) {
            if (!closed.get()) {
                E2eTrustedBackendEvidence.started(runtimeId, generation, failure(error))
            }
        } finally {
            runCatching { runtime?.close() }
            worker.compareAndSet(Thread.currentThread(), null)
        }
    }

    private fun awaitResult(runtime: V8Runtime, network: V86TrustedBackendNetworkProbe) {
        val deadline = SystemClock.elapsedRealtime() + PROBE_TIMEOUT_MS
        runtime.globalObject.get<V8ValueFunction>(TIMER_GLOBAL).use { tick ->
            runtime.globalObject.get<V8ValueFunction>(TAKE_REQUEST_GLOBAL).use { take ->
                runtime.globalObject.get<V8ValueFunction>(RESOLVE_REQUEST_GLOBAL).use { resolve ->
                    while (
                        !closed.get() &&
                        !runtime.globalObject.hasOwnProperty(RESULT_GLOBAL) &&
                        !runtime.globalObject.hasOwnProperty(FAILURE_GLOBAL) &&
                        SystemClock.elapsedRealtime() < deadline
                    ) {
                        deliverTerminals(runtime, resolve, network)
                        if (pendingRequests.get() == 0) {
                            tick.callInteger(runtime.globalObject)
                            runtime.await(V8AwaitMode.RunNoWait)
                            drainRequests(runtime, take)
                            deliverTerminals(runtime, resolve, network)
                        }
                        SystemClock.sleep(1)
                    }
                }
            }
        }
        check(!closed.get()) { "v86 trusted Backend was closed" }
        check(!runtime.globalObject.hasOwnProperty(FAILURE_GLOBAL)) {
            runtime.globalObject.getString(FAILURE_GLOBAL)
        }
        check(runtime.globalObject.hasOwnProperty(RESULT_GLOBAL)) {
            "v86 trusted Backend timed out: ${diagnostics(runtime)}"
        }
        val result = JSONObject(runtime.globalObject.getString(RESULT_GLOBAL))
        E2eTrustedBackendEvidence.started(
            runtimeId,
            generation,
            JSONObject()
                .put("ok", true)
                .put("result", JSONObject().put("kind", "value").put("value", result))
                .toString(),
        )
    }

    private fun drainRequests(
        runtime: V8Runtime,
        take: V8ValueFunction,
    ) {
        while (true) {
            val source = take.callString(runtime.globalObject)
            if (source.isEmpty()) return
            val envelope = JSONObject(source)
            val id = envelope.getLong("id")
            val channel = when (envelope.getString("channel")) {
                RuntimeTrustedBackendChannel.LINUX_FILESYSTEM.wireName ->
                    RuntimeTrustedBackendChannel.LINUX_FILESYSTEM
                RuntimeTrustedBackendChannel.LINUX_PROCESS_NETWORK.wireName ->
                    RuntimeTrustedBackendChannel.LINUX_PROCESS_NETWORK
                else -> error("Unknown trusted Backend channel")
            }
            val request = envelope.getJSONObject("request")
            pendingRequests.incrementAndGet()
            host.invoke(
                channel,
                request.toString(),
            ) { terminal ->
                receivedTerminals.incrementAndGet()
                terminals.add(TrustedBackendTerminal(channel, id, request, terminal))
            }
        }
    }

    private fun deliverTerminals(
        runtime: V8Runtime,
        resolve: V8ValueFunction,
        network: V86TrustedBackendNetworkProbe,
    ) {
        while (true) {
            val terminal = terminals.poll() ?: return
            val source = if (terminal.channel == RuntimeTrustedBackendChannel.LINUX_PROCESS_NETWORK) {
                network.authorizedTerminal(terminal.request, terminal.source)
            } else {
                terminal.source
            }
            resolve.callVoid(runtime.globalObject, terminal.id.toDouble(), source)
            check(pendingRequests.decrementAndGet() >= 0)
            deliveredTerminals.incrementAndGet()
        }
    }

    private fun diagnostics(runtime: V8Runtime): String = runCatching {
        runtime.globalObject.get<V8ValueFunction>(DIAGNOSTICS_GLOBAL).use { diagnostics ->
            JSONObject(diagnostics.callString(runtime.globalObject))
                .put("kotlinDeliveredTerminals", deliveredTerminals.get())
                .put("kotlinPendingRequests", pendingRequests.get())
                .put("kotlinQueuedTerminals", terminals.size)
                .put("kotlinReceivedTerminals", receivedTerminals.get())
                .toString()
        }
    }.getOrDefault("unavailable")

    private fun seedWorkspace() {
        val created = terminalValue(
            invokeFilesystem(
                filesystemRequest()
                    .put("flags", 0x41)
                    .put("linuxPid", 1)
                    .put("operation", "create")
                    .put("path", "/workspace/input.txt")
                    .toString(),
            ),
        )
        val handle = created.getString("handle")
        val bytes = "android-guest-input".toByteArray(Charsets.US_ASCII)
        terminalValue(
            invokeFilesystem(
                filesystemRequest()
                    .put("bytes", JSONArray(bytes.map(Byte::toInt)))
                    .put("handle", handle)
                    .put("linuxPid", 1)
                    .put("offset", 0)
                    .put("operation", "write")
                    .put("path", "/workspace/input.txt")
                    .toString(),
            ),
        )
        terminalValue(
            invokeFilesystem(
                filesystemRequest()
                    .put("handle", handle)
                    .put("linuxPid", 1)
                    .put("operation", "release")
                    .put("path", "/workspace/input.txt")
                    .toString(),
            ),
        )
    }

    private fun terminalValue(source: String): JSONObject {
        val terminal = JSONObject(source)
        check(terminal.getBoolean("ok")) { terminal.toString() }
        val result = terminal.getJSONObject("result")
        check(result.getString("kind") == "value")
        return result.optJSONObject("value") ?: JSONObject()
    }

    private fun filesystemRequest() = JSONObject()
        .put("environmentId", "$runtimeId:$generation:android-v86")
        .put("executableId", "android-v86-fuse")
        .put("policy", e2eTrustedBackendProcessPolicy())
        .put("processId", 9)
        .put("processResourceId", "android-v86-fuse-process")
        .put("scope", "runtime")

    private fun invokeFilesystem(requestJson: String): String {
        val terminal = AtomicReference<String>()
        val latch = CountDownLatch(1)
        host.invoke(RuntimeTrustedBackendChannel.LINUX_FILESYSTEM, requestJson) { value ->
            if (terminal.compareAndSet(null, value)) latch.countDown()
        }
        check(latch.await(INVOCATION_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            "v86 filesystem invocation timed out"
        }
        return checkNotNull(terminal.get())
    }

    private fun configuration() = JSONObject()
        .put("environmentId", "$runtimeId:$generation:android-v86")
        .put("networkPort", E2E_PROCESS_NETWORK_PORT)
        .put("policy", e2eTrustedBackendProcessPolicy())

    private fun staleProbeRequest() = JSONObject()
        .put("environmentId", "$runtimeId:$generation:android-v86-close")
        .put("executableId", "android-v86-fuse")
        .put("flags", 0)
        .put("linuxPid", 1)
        .put("operation", "getattr")
        .put("path", "/workspace")
        .put("policy", e2eTrustedBackendProcessPolicy())
        .put("processId", 9)
        .put("processResourceId", "android-v86-fuse-process")
        .put("scope", "runtime")

    private fun manifest(): JSONObject = JSONObject(
        assets.open(MANIFEST_PATH).use { input -> input.readBytes().toString(Charsets.UTF_8) },
    )

    private fun readVerifiedAsset(manifest: JSONObject, path: String): ByteArray {
        val entries = manifest.getJSONArray("assets")
        val entry = (0 until entries.length())
            .map(entries::getJSONObject)
            .first { item -> item.getString("path") == path }
        check(entry.getString("kind") == "backend-probe" && !entry.getBoolean("guestReadable"))
        val value = assets.open(path, AssetManager.ACCESS_STREAMING).use { input -> input.readBytes() }
        check(value.size <= MAX_ASSET_BYTES)
        check(entry.getString("sha256") == sha256(value))
        return value
    }

    private fun installBuffer(runtime: V8Runtime, name: String, bytes: ByteArray) {
        runtime.createV8ValueArrayBuffer(bytes.size).use { buffer ->
            check(buffer.fromBytes(bytes) && runtime.globalObject.set(name, buffer))
        }
    }

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun failure(error: Throwable) = JSONObject()
        .put("ok", false)
        .put(
            "error",
            JSONObject()
                .put("code", "provider.unavailable")
                .put("message", error.message ?: "v86 trusted Backend failed"),
        )
        .toString()

    private data class TrustedBackendTerminal(
        val channel: RuntimeTrustedBackendChannel,
        val id: Long,
        val request: JSONObject,
        val source: String,
    )

    private companion object {
        private const val DIAGNOSTICS_GLOBAL = "__holoV86TrustedBackendDiagnostics"
        private const val INVOCATION_TIMEOUT_MS = 15_000L
        private const val FAILURE_GLOBAL = "__holoV86TrustedBackendFailure"
        private const val MANIFEST_PATH = "runtime/asset-manifest.json"
        private const val MAX_ASSET_BYTES = 8 * 1024 * 1024
        private const val PROBE_TIMEOUT_MS = 120_000L
        private const val RESULT_GLOBAL = "__holoV86TrustedBackendResult"
        private const val RESOLVE_REQUEST_GLOBAL = "__holoResolveV86TrustedBackendRequest"
        private const val START_GLOBAL = "__holoStartV86TrustedBackendProbe"
        private const val TAKE_REQUEST_GLOBAL = "__holoTakeV86TrustedBackendRequest"
        private const val TIMER_GLOBAL = "__holoRunV86Timers"
        private const val V86_ROOT = "runtime/process-backends/v86"
        private const val VM_GLOBAL = "__holoV86TrustedBackendVm"
        private const val WORKER_CLOSE_TIMEOUT_MS = 10_000L
    }
}
