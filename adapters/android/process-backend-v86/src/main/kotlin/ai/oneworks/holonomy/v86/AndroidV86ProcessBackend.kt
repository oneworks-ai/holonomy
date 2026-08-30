package ai.oneworks.holonomy.v86

import android.os.SystemClock
import android.util.Log
import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.RuntimeTrustedBackendChannel
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValueObject
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

fun interface AndroidV86ProcessEventSink {
    fun emit(event: JSONObject)
}

fun interface AndroidV86NetworkEventSink {
    fun emit(event: JSONObject)
}

interface AndroidV86NetworkTransport : AutoCloseable {
    fun execute(request: JSONObject, authorizationTerminal: JSONObject): JSONObject

    fun open(
        request: JSONObject,
        authorizationTerminal: JSONObject,
        sink: AndroidV86NetworkEventSink,
    ): JSONObject = failure("provider.unavailable")

    fun control(request: JSONObject): JSONObject = failure("provider.unavailable")

    override fun close() = Unit

    companion object {
        fun success(value: JSONObject = JSONObject()): JSONObject = JSONObject()
            .put("ok", true)
            .put("result", JSONObject().put("kind", "value").put("value", value))

        fun failure(code: String): JSONObject = JSONObject()
            .put("ok", false)
            .put("error", JSONObject().put("code", code))
    }
}

/** One generation-owned v86/Linux environment running in a dedicated trusted V8 Runtime. */
class AndroidV86ProcessBackend(
    private val assetStore: AndroidV86AssetStore,
    private val configuration: JSONObject,
    private val eventSink: AndroidV86ProcessEventSink,
    private val networkTransport: AndroidV86NetworkTransport? = null,
) : RuntimeTrustedBackend {
    private val closed = AtomicBoolean(false)
    private val commands = ConcurrentLinkedQueue<String>()
    private val failure = AtomicReference<Throwable?>()
    private val hostTerminals = ConcurrentLinkedQueue<HostTerminal>()
    private val networkEvents = ConcurrentLinkedQueue<String>()
    private val readiness = CompletableFuture<Unit>()
    private val networkExecutor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "holonomy-v86-network-${configuration.getString("environmentId")}")
    }
    private val started = AtomicBoolean(false)
    private val worker = AtomicReference<Thread?>()
    private lateinit var host: RuntimeTrustedBackendHost

    override fun start(host: RuntimeTrustedBackendHost): CompletableFuture<Unit> {
        check(started.compareAndSet(false, true)) { "Android v86 Backend already started" }
        this.host = host
        Thread(::run, "holonomy-v86-${configuration.getString("environmentId")}").also { thread ->
            worker.set(thread)
            thread.start()
        }
        return readiness
    }

    fun submit(command: JSONObject) {
        check(started.get() && !closed.get() && failure.get() == null && worker.get()?.isAlive == true) {
            "Android v86 Backend is unavailable"
        }
        commands.add(command.toString())
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        readiness.completeExceptionally(IllegalStateException("Android v86 Backend closed before readiness"))
        runCatching { networkTransport?.close() }
        networkExecutor.shutdownNow()
        worker.get()?.let { thread ->
            if (thread !== Thread.currentThread()) {
                thread.join(CLOSE_TIMEOUT_MS)
                check(!thread.isAlive) { "Android v86 Backend did not close" }
            }
        }
    }

    private fun run() {
        var runtime: V8Runtime? = null
        try {
            Log.i(TAG, "Starting the generation-owned v86 environment")
            runtime = V8Host.getV8Instance().createV8Runtime()
            install(runtime)
            Log.i(TAG, "Installed the generation-owned v86 environment")
            eventLoop(runtime)
        } catch (error: Throwable) {
            failure.compareAndSet(null, error)
            readiness.completeExceptionally(error)
            Log.e(TAG, "The generation-owned v86 environment failed", error)
            if (!closed.get()) {
                eventSink.emit(
                    JSONObject()
                        .put("code", "provider.unavailable")
                        .put("event", "backend-error")
                        .put("message", error.message ?: "Android v86 Backend failed"),
                )
            }
        } finally {
            runCatching {
                if (runtime?.globalObject?.hasOwnProperty(VM_GLOBAL) == true) {
                    runtime.getExecutor("void globalThis.$VM_GLOBAL.destroy()").executeVoid()
                }
            }
            runCatching { runtime?.close() }
            worker.compareAndSet(Thread.currentThread(), null)
        }
    }

    private fun install(runtime: V8Runtime) {
        runtime.getExecutor(assetStore.read("shim.mjs").toString(Charsets.UTF_8)).executeVoid()
        runtime.getExecutor(assetStore.read("driver-support.mjs").toString(Charsets.UTF_8)).executeVoid()
        runtime.getExecutor(assetStore.read("driver-network.mjs").toString(Charsets.UTF_8)).executeVoid()
        runtime.getExecutor(assetStore.read("driver-sockets.mjs").toString(Charsets.UTF_8)).executeVoid()
        runtime.getExecutor(assetStore.read("fuse-support.mjs").toString(Charsets.UTF_8)).executeVoid()
        runtime.getExecutor(assetStore.read("fuse.mjs").toString(Charsets.UTF_8)).executeVoid()
        runtime.getExecutor(assetStore.read("driver.mjs").toString(Charsets.UTF_8)).executeVoid()
        installBuffer(runtime, "__holoV86Wasm", assetStore.read("v86.wasm"))
        installBuffer(runtime, "__holoV86Bios", assetStore.read("seabios.bin"))
        installBuffer(runtime, "__holoV86Kernel", assetStore.read("kernel.bin"))
        installBuffer(runtime, "__holoV86Initrd", assetStore.read("agent.cpio"))
        val module = runtime.getExecutor(assetStore.read("libv86.mjs").toString(Charsets.UTF_8))
            .setModule(true)
            .setResourceName("holo:///runtime/process-backends/v86/libv86.mjs")
            .compileV8Module()
        try {
            check(module.instantiate()) { "v86 module could not be instantiated" }
            module.evaluate<V8Value>(false).close()
            runtime.await(V8AwaitMode.RunTillNoMoreTasks)
            (module.namespace as V8ValueObject).use { namespace ->
                namespace.get<V8ValueFunction>("V86").use { constructor ->
                    runtime.globalObject.get<V8ValueFunction>(START_GLOBAL).use { start ->
                        start.callVoid(runtime.globalObject, constructor, configuration.toString())
                    }
                }
            }
        } finally {
            module.close()
        }
    }

    private fun eventLoop(runtime: V8Runtime) {
        val startupDeadline = SystemClock.elapsedRealtime() + configuration.getLong("startupTimeoutMs")
        runtime.globalObject.get<V8ValueFunction>(TIMER_GLOBAL).use { timers ->
            runtime.globalObject.get<V8ValueFunction>(COMMAND_GLOBAL).use { command ->
                runtime.globalObject.get<V8ValueFunction>(TAKE_EVENT_GLOBAL).use { takeEvent ->
                    runtime.globalObject.get<V8ValueFunction>(TAKE_HOST_REQUEST_GLOBAL).use { takeHost ->
                        runtime.globalObject.get<V8ValueFunction>(RESOLVE_HOST_REQUEST_GLOBAL).use { resolveHost ->
                            runtime.globalObject.get<V8ValueFunction>(NETWORK_EVENT_GLOBAL).use { networkEvent ->
                                while (!closed.get()) {
                                    if (!readiness.isDone && SystemClock.elapsedRealtime() >= startupDeadline) {
                                        error("Android v86 Backend startup timed out")
                                    }
                                    timers.callInteger(runtime.globalObject)
                                    runtime.await(V8AwaitMode.RunNoWait)
                                    drainCommands(runtime, command)
                                    drainHostRequests(runtime, takeHost)
                                    deliverHostTerminals(runtime, resolveHost)
                                    deliverNetworkEvents(runtime, networkEvent)
                                    drainEvents(runtime, takeEvent)
                                    SystemClock.sleep(1)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private fun drainCommands(runtime: V8Runtime, command: V8ValueFunction) {
        while (true) {
            val source = commands.peek() ?: return
            if (!command.callBoolean(runtime.globalObject, source)) return
            commands.remove(source)
        }
    }

    private fun drainHostRequests(runtime: V8Runtime, take: V8ValueFunction) {
        while (true) {
            val source = take.callString(runtime.globalObject)
            if (source.isEmpty()) return
            val envelope = JSONObject(source)
            val request = envelope.getJSONObject("request")
            if (envelope.getString("channel") == LOCAL_NETWORK_CHANNEL) {
                if (configuration.optBoolean("diagnostics")) {
                    Log.d(TAG, "Network control ${request.getString("operation")} handle=${request.getLong("handleId")}")
                }
                networkExecutor.execute {
                    val terminal = runCatching {
                        networkTransport?.control(JSONObject(request.toString()))
                            ?: AndroidV86NetworkTransport.failure("provider.unavailable")
                    }.getOrElse { AndroidV86NetworkTransport.failure("provider.unavailable") }
                    hostTerminals.add(HostTerminal(envelope.getLong("id"), terminal.toString()))
                }
                continue
            }
            val channel = when (envelope.getString("channel")) {
                RuntimeTrustedBackendChannel.LINUX_FILESYSTEM.wireName ->
                    RuntimeTrustedBackendChannel.LINUX_FILESYSTEM
                RuntimeTrustedBackendChannel.LINUX_CAPABILITY.wireName ->
                    RuntimeTrustedBackendChannel.LINUX_CAPABILITY
                RuntimeTrustedBackendChannel.LINUX_PROCESS_EXECUTION.wireName ->
                    RuntimeTrustedBackendChannel.LINUX_PROCESS_EXECUTION
                RuntimeTrustedBackendChannel.LINUX_PROCESS_NETWORK.wireName ->
                    RuntimeTrustedBackendChannel.LINUX_PROCESS_NETWORK
                else -> error("Unknown Android v86 trusted channel")
            }
            if (configuration.optBoolean("diagnostics")) {
                val detail = when (channel) {
                    RuntimeTrustedBackendChannel.LINUX_CAPABILITY -> {
                        val command = request.optJSONArray("command")
                        " domain=${command?.optString(0) ?: "invalid"} tokens=${command?.length() ?: 0}"
                    }
                    RuntimeTrustedBackendChannel.LINUX_PROCESS_EXECUTION ->
                        " executable=${request.optString("executableId", "invalid")}"
                    else -> ""
                }
                Log.d(TAG, "Host ${channel.wireName} request$detail")
            }
            host.invoke(channel, request.toString()) { sourceTerminal ->
                if (configuration.optBoolean("diagnostics")) {
                    Log.d(TAG, "Host ${channel.wireName} terminal ${terminalDiagnostic(sourceTerminal)}")
                }
                if (channel == RuntimeTrustedBackendChannel.LINUX_PROCESS_NETWORK) {
                    networkExecutor.execute {
                        val terminal = transformNetwork(request, sourceTerminal)
                        hostTerminals.add(HostTerminal(envelope.getLong("id"), terminal.toString()))
                    }
                } else {
                    hostTerminals.add(HostTerminal(envelope.getLong("id"), sourceTerminal))
                }
            }
        }
    }

    private fun transformNetwork(request: JSONObject, source: String): JSONObject {
        val authorization = JSONObject(source)
        if (!authorization.optBoolean("ok") || networkTransport == null) return authorization
        if (configuration.optBoolean("diagnostics")) {
            Log.d(
                TAG,
                "Network ${request.optString("transport", "http")} ${request.optString("operation", "request")} " +
                    "${request.optString("hostname", request.optString("url"))}:${request.optInt("port", 0)}",
            )
        }
        return if (request.optString("operation") == "open") {
            networkTransport.open(JSONObject(request.toString()), authorization) { event ->
                if (!closed.get()) networkEvents.add(event.toString())
            }
        } else {
            networkTransport.execute(JSONObject(request.toString()), authorization)
        }
    }

    private fun terminalDiagnostic(source: String): String = runCatching {
        val terminal = JSONObject(source)
        if (terminal.optBoolean("ok")) {
            "ok"
        } else {
            val error = terminal.optJSONObject("error")
            val code = error?.optString("code") ?: "invalid"
            val message = error?.optString("message")?.take(160)?.replace(Regex("[\\r\\n\\t]"), " ")
            val operation = error?.optString("operation")?.takeIf(String::isNotBlank)
            listOfNotNull(code, operation?.let { "operation=$it" }, message?.let { "message=$it" }).joinToString(" ")
        }
    }.getOrDefault("invalid")

    private fun deliverHostTerminals(runtime: V8Runtime, resolve: V8ValueFunction) {
        while (true) {
            val terminal = hostTerminals.poll() ?: return
            resolve.callBoolean(runtime.globalObject, terminal.id.toDouble(), terminal.source)
        }
    }

    private fun deliverNetworkEvents(runtime: V8Runtime, emit: V8ValueFunction) {
        // v86 schedules packet transmission from the received callback. Delivering data, end and
        // close in one Host turn can close the emulated connection before that packet task runs.
        val event = networkEvents.poll() ?: return
        if (configuration.optBoolean("diagnostics")) {
            val value = JSONObject(event)
            Log.d(
                TAG,
                "Network event ${value.getString("event")} handle=${value.getLong("handleId")} " +
                    "bytes=${value.optJSONArray("bytes")?.length() ?: 0}",
            )
        }
        emit.callBoolean(runtime.globalObject, event)
    }

    private fun drainEvents(runtime: V8Runtime, take: V8ValueFunction) {
        while (true) {
            val source = take.callString(runtime.globalObject)
            if (source.isEmpty()) return
            val event = JSONObject(source)
            if (event.getString("event") == "backend-diagnostic") {
                Log.d(TAG, "Linux: ${event.optString("line")}")
            } else if (event.getString("event") == "ready") {
                readiness.complete(Unit)
            } else {
                if (event.getString("event") == "backend-error") {
                    readiness.completeExceptionally(
                        IllegalStateException(event.optString("message", "Android v86 Backend failed")),
                    )
                }
                eventSink.emit(event)
            }
        }
    }

    private fun installBuffer(runtime: V8Runtime, name: String, bytes: ByteArray) {
        runtime.createV8ValueArrayBuffer(bytes.size).use { buffer ->
            check(buffer.fromBytes(bytes) && runtime.globalObject.set(name, buffer))
        }
    }

    private data class HostTerminal(val id: Long, val source: String)

    private companion object {
        private const val TAG = "HolonomyV86Backend"
        private const val CLOSE_TIMEOUT_MS = 10_000L
        private const val COMMAND_GLOBAL = "__holoV86BackendCommand"
        private const val LOCAL_NETWORK_CHANNEL = "linuxNetworkControl"
        private const val NETWORK_EVENT_GLOBAL = "__holoV86BackendNetworkEvent"
        private const val RESOLVE_HOST_REQUEST_GLOBAL = "__holoResolveV86BackendHostRequest"
        private const val START_GLOBAL = "__holoStartV86ProcessBackend"
        private const val TAKE_EVENT_GLOBAL = "__holoTakeV86BackendEvent"
        private const val TAKE_HOST_REQUEST_GLOBAL = "__holoTakeV86BackendHostRequest"
        private const val TIMER_GLOBAL = "__holoRunV86Timers"
        private const val VM_GLOBAL = "__holoV86BackendVm"
    }
}
