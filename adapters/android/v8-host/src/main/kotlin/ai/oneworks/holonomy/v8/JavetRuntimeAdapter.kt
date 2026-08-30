package ai.oneworks.holonomy.v8

import android.content.res.AssetManager
import android.os.SystemClock
import ai.oneworks.holonomy.host.RuntimeAdapter
import ai.oneworks.holonomy.host.RuntimeAdapterHost
import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeEngineException
import ai.oneworks.holonomy.host.RuntimeEvaluation
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.host.RuntimeThreadGuard
import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import com.caoccao.javet.annotations.V8Function
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.enums.V8ValueType
import com.caoccao.javet.interop.V8Inspector
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.interop.callback.IV8ModuleResolver
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.IV8Module
import com.caoccao.javet.values.reference.IV8ValuePromise
import com.caoccao.javet.values.reference.V8ValueArray
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValueObject
import com.caoccao.javet.values.reference.V8ValuePromise
import com.caoccao.javet.values.reference.V8ValueTypedArray
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

internal class JavetRuntimeAdapter(
    assets: AssetManager,
    private val bootstrapAssetPath: String,
    private val host: RuntimeAdapterHost,
    private val inspectorOptions: AdbInspectorOptions?,
    private val moduleResolver: RuntimeModuleResolver?,
    private val nativeHost: RuntimeNativeHost,
    private val capabilityHost: RuntimeCapabilityHost?,
    private val trustedBackend: RuntimeTrustedBackend?,
    private val processHost: RuntimeProcessHost,
    private val runtimeArchitecture: String,
    private val threadGuard: RuntimeThreadGuard,
) : RuntimeAdapter {
    private val assetResolver = AndroidAssetModuleResolver(assets)
    private val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
    private val pluginHost = if (capabilityHost != null || processHost.configuration.runtimePluginsJson != "[]") {
        AndroidRuntimePluginHost(
            assets,
            capabilityHost,
            moduleResolver,
            processHost,
            host,
            threadGuard,
        )
    } else {
        null
    }
    private val callbacks = HostCallbacks()
    private val diagnosticsExecutor = ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        ArrayBlockingQueue(MAX_PENDING_NETWORK_DIAGNOSTICS),
        { runnable -> Thread(runnable, "holonomy-network-diagnostics").apply { isDaemon = true } },
        ThreadPoolExecutor.DiscardPolicy(),
    )
    private val hostObject: V8ValueObject
    private val inspectorMessageLoopBlocked = AtomicBoolean(inspectorOptions?.waitForDebugger == true)
    private val inspector: V8Inspector? = inspectorOptions?.let { options ->
        runtime.createV8Inspector(options.targetTitle, options.waitForDebugger)
    }
    private val inspectorServer: AdbInspectorServer? = inspectorOptions?.let { options ->
        AdbInspectorServer(
            inspector = requireNotNull(inspector),
            options = options,
            sendRequest = { message ->
                if (inspectorMessageLoopBlocked.get()) {
                    inspector.sendRequest(message)
                } else {
                    host.requestRuntimeTask {
                        threadGuard.checkAccess()
                        inspector.sendRequest(message)
                    }
                }
            },
            onMessageLoopBlocked = inspectorMessageLoopBlocked::set,
            v8Version = runtime.version,
        )
    }
    private val moduleCache = mutableMapOf<String, IV8Module>()
    private val pendingModuleEvaluations = mutableSetOf<V8ValuePromise>()
    private val closed = AtomicBoolean(false)
    private val nativeHostClosed = AtomicBoolean(false)
    private var moduleResolutionFailure: RuntimeEngineException? = null
    private var checkpointRequested = false
    private var controlDriver: V8ValueFunction? = null
    private var syntheticModuleRegistry: V8ValueObject? = null
    private var nativeDriver: V8ValueFunction? = null
    private var started = false
    private var turnDriver: V8ValueFunction? = null
    private var timerDriver: V8ValueFunction? = null
    private var trustedBackendBridge: JavetTrustedBackendBridge? = null
    private val capabilitySubscriptions = mutableMapOf<String, CapabilitySubscription>()
    private var nextCapabilitySubscriptionId = 1L

    init {
        threadGuard.checkAccess()
        hostObject = runtime.createV8ValueObject()
        hostObject.bind(callbacks)
        runtime.globalObject.set(HOST_GLOBAL, hostObject)
        installModuleResolver()
    }

    override fun start() {
        threadGuard.checkAccess()
        if (started) return
        try {
            pluginHost?.start()
            if (inspectorOptions?.waitForDebugger == true) {
                requireNotNull(inspector).waitForDebugger()
            }
            val bootstrap = assetResolver.resolve(
                "holonomy:///$bootstrapAssetPath",
                null,
            )
            executeSourceModule(bootstrap.resourceUrl, bootstrap.source)
            checkpointRequested = true
            drainMicrotasks()
            if (trustedBackend != null) {
                val trustedDriver = runtime.globalObject.get<V8ValueFunction>(TRUSTED_BACKEND_DRIVER_GLOBAL)
                    ?: throw RuntimeEngineException(
                        RuntimeEngineErrorCode.INTERNAL,
                        "The trusted Backend driver was not installed",
                    )
                val bridge = JavetTrustedBackendBridge(
                    runtime = runtime,
                    driver = trustedDriver,
                    runtimeHost = host,
                    driveRuntime = {
                        checkpointRequested = true
                        runHostTurn()
                    },
                )
                trustedBackendBridge = bridge
                trustedBackend.start(bridge).get()
            }
            val runtimeReady = runtime.globalObject.get<V8ValueFunction>(READY_DRIVER_GLOBAL)
                ?: throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The runtime readiness driver was not installed",
                )
            val readiness: V8Value = runtimeReady.call(runtime.globalObject, *emptyArray<Any>())
            try {
                awaitRuntimeReadiness(readiness)
            } finally {
                readiness.close()
                runtimeReady.close()
            }
            runtime.globalObject.delete(READY_DRIVER_GLOBAL)
            turnDriver = runtime.globalObject.get<V8ValueFunction>(TURN_DRIVER_GLOBAL)
                ?: throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The runtime turn driver was not installed",
                )
            runtime.globalObject.delete(TURN_DRIVER_GLOBAL)
            timerDriver = runtime.globalObject.get<V8ValueFunction>(TIMER_DRIVER_GLOBAL)
                ?: throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The runtime timer driver was not installed",
                )
            runtime.globalObject.delete(TIMER_DRIVER_GLOBAL)
            nativeDriver = runtime.globalObject.get<V8ValueFunction>(NATIVE_DRIVER_GLOBAL)
                ?: throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The runtime native event driver was not installed",
                )
            runtime.globalObject.delete(NATIVE_DRIVER_GLOBAL)
            controlDriver = runtime.globalObject.get<V8ValueFunction>(CONTROL_DRIVER_GLOBAL)
                ?: throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The runtime control driver was not installed",
                )
            runtime.globalObject.delete(CONTROL_DRIVER_GLOBAL)
            runtime.globalObject.delete(TRUSTED_BACKEND_DRIVER_GLOBAL)
            runtime.globalObject.delete(HOST_GLOBAL)
            checkpointRequested = true
            drainMicrotasks()
            started = true
        } catch (error: Throwable) {
            runCatching { trustedBackendBridge?.close() }
            trustedBackendBridge = null
            runCatching { pluginHost?.close() }
            runCatching { capabilityHost?.close() }
            runCatching { trustedBackend?.close() }
            processHost.write(RuntimeOutputStream.STDERR, "Android Runtime start failed: bootstrap_runtime\n")
            throw error
        }
    }

    override fun evaluate(source: String): RuntimeEvaluation {
        threadGuard.checkAccess()
        val envelopeJson = runtime.getExecutor(evaluationEnvelopeScript(source)).executeString()
        drainMicrotasks()
        return parseEvaluationEnvelope(envelopeJson)
    }

    override fun executeModule(module: RuntimeModuleSource) {
        threadGuard.checkAccess()
        validateExternalModule(module, allowInternal = false)
        if (capabilityHost == null) {
            executeSourceModule(module.resourceUrl, module.source)
        } else {
            executeCapabilitySourceModule(module.resourceUrl, module.source)
        }
        checkpointRequested = true
        drainMicrotasks()
    }

    override fun control(operation: String, valueJson: String) {
        threadGuard.checkAccess()
        val driver = controlDriver ?: throw RuntimeEngineException(
            RuntimeEngineErrorCode.NOT_SUPPORTED,
            "The runtime control channel is unavailable",
        )
        driver.callVoid(runtime.globalObject, operation, valueJson)
        checkpointRequested = true
        drainMicrotasks()
    }

    override fun terminateExecution() {
        val runtimeError = runCatching { runtime.terminateExecution() }.exceptionOrNull()
        val backendError = runCatching { trustedBackend?.close() }.exceptionOrNull()
        (runtimeError ?: backendError)?.let { throw it }
    }

    override fun close() {
        threadGuard.checkAccess()
        closed.set(true)
        diagnosticsExecutor.shutdownNow()
        runCatching { trustedBackendBridge?.close() }
        trustedBackendBridge = null
        runCatching { pluginHost?.close() }
        runCatching { capabilityHost?.close() }
        runCatching { trustedBackend?.close() }
        closeNativeHost()
        runCatching { inspectorServer?.close() }
        runCatching { inspector?.close() }
        runCatching { turnDriver?.close() }
        turnDriver = null
        runCatching { timerDriver?.close() }
        timerDriver = null
        runCatching { nativeDriver?.close() }
        nativeDriver = null
        runCatching { controlDriver?.close() }
        controlDriver = null
        capabilitySubscriptions.values.forEach { subscription ->
            runCatching { subscription.native.close() }
            runCatching { subscription.callback.close() }
        }
        capabilitySubscriptions.clear()
        runCatching { syntheticModuleRegistry?.close() }
        syntheticModuleRegistry = null
        runCatching { hostObject.unbind(callbacks) }
        runCatching { hostObject.close() }
        pendingModuleEvaluations.forEach { promise -> runCatching { promise.close() } }
        pendingModuleEvaluations.clear()
        moduleCache.clear()
        runtime.close()
    }

    private fun installModuleResolver() {
        runtime.setV8ModuleResolver(
            object : IV8ModuleResolver {
                override fun resolve(
                    v8Runtime: V8Runtime,
                    resourceName: String,
                    v8ModuleReferrer: IV8Module,
                ): IV8Module? {
                    threadGuard.checkAccess()
                    val referrerUrl = runCatching { v8ModuleReferrer.resourceName }.getOrNull()
                    if (hasScheme(resourceName, NODE_SCHEME) || hasScheme(resourceName, HOLO_SCHEME)) {
                        return resolveSyntheticModule(v8Runtime, resourceName)
                    }
                    val module = resolveSourceModule(resourceName, referrerUrl) ?: return null

                    moduleCache[module.resourceUrl]?.let { return it }

                    return try {
                        v8Runtime.getExecutor(sourceWithImportMeta(module.resourceUrl, module.source))
                            .setModule(true)
                            .setResourceName(module.resourceUrl)
                            .compileV8Module()
                            .also { moduleCache[module.resourceUrl] = it }
                    } catch (_: Throwable) {
                        moduleResolutionFailure = RuntimeEngineException(
                            RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                            "The resolved runtime module could not be compiled",
                        )
                        null
                    }
                }
            },
        )
    }

    private fun executeSourceModule(resourceUrl: String, source: String) {
        moduleResolutionFailure = null
        try {
            evaluateModule(compileSourceModule(resourceUrl, source), instantiate = true)
            moduleResolutionFailure?.let { throw it }
        } catch (error: Throwable) {
            throw moduleResolutionFailure ?: error
        } finally {
            moduleResolutionFailure = null
        }
    }

    private fun executeCapabilitySourceModule(resourceUrl: String, source: String) {
        moduleResolutionFailure = null
        var stage = "compile"
        try {
            val module = compileSourceModule(resourceUrl, source)
            stage = "instantiate"
            if (!module.instantiate()) {
                throw RuntimeEngineException(
                    RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                    "The capability module graph could not be instantiated",
                )
            }
            moduleResolutionFailure?.let { throw it }
            runtime.allowEval(false)
            runtime.globalObject.delete("WebAssembly")
            stage = "evaluate"
            evaluateModule(module, instantiate = false)
        } catch (error: Throwable) {
            processHost.write(
                RuntimeOutputStream.STDERR,
                "Android Runtime start failed: capability_entry_$stage\n",
            )
            throw moduleResolutionFailure ?: error
        } finally {
            moduleResolutionFailure = null
        }
    }

    private fun compileSourceModule(resourceUrl: String, source: String): IV8Module =
        runtime.getExecutor(sourceWithImportMeta(resourceUrl, source))
            .setModule(true)
            .setResourceName(resourceUrl)
            .compileV8Module()
            .also { moduleCache[resourceUrl] = it }

    private fun evaluateModule(module: IV8Module, instantiate: Boolean) {
        val evaluation = if (instantiate) module.execute<V8Value>(true) else module.evaluate<V8Value>(false)
        if (evaluation is V8ValuePromise) {
            observeModuleEvaluation(evaluation)
        } else {
            runCatching { evaluation?.close() }
        }
    }

    private fun observeModuleEvaluation(promise: V8ValuePromise) {
        pendingModuleEvaluations += promise
        val settled = AtomicBoolean(false)
        fun finish(failed: Boolean) {
            if (!settled.compareAndSet(false, true)) return
            pendingModuleEvaluations.remove(promise)
            runCatching { promise.close() }
            if (failed) {
                processHost.exit(1)
                host.requestTermination()
            }
        }
        promise.register(
            object : IV8ValuePromise.IListener {
                override fun onCatch(value: V8Value) = finish(true)

                override fun onFulfilled(value: V8Value) = finish(false)

                override fun onRejected(value: V8Value) = finish(true)
            },
        )
        promise.markAsHandled()
    }

    private fun sourceWithImportMeta(resourceUrl: String, source: String): String {
        val initializer = "import.meta.url=${JSONObject.quote(resourceUrl)};"
        if (!source.startsWith("#!")) return initializer + source
        val lineEnd = source.indexOf('\n')
        return if (lineEnd < 0) "$source\n$initializer" else source.substring(0, lineEnd + 1) + initializer + source.substring(lineEnd + 1)
    }

    private fun resolveSourceModule(resourceName: String, referrerUrl: String?): RuntimeModuleSource? {
        val resourceIsInternal = hasScheme(resourceName, INTERNAL_SCHEME)
        val referrerIsInternal = referrerUrl != null && hasScheme(referrerUrl, INTERNAL_SCHEME)
        val resourceIsPlugin = hasScheme(resourceName, PLUGIN_SCHEME)
        val referrerIsPlugin = referrerUrl != null && hasScheme(referrerUrl, PLUGIN_SCHEME)
        if (resourceIsInternal && !referrerIsInternal) {
            moduleResolutionFailure = RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "Guest modules cannot import reserved runtime assets",
            )
            return null
        }
        if (resourceIsPlugin && !referrerIsInternal && !referrerIsPlugin) {
            moduleResolutionFailure = RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "Guest modules cannot import Runtime plugin assets",
            )
            return null
        }
        val pluginLibraryRequest = referrerIsPlugin && resourceName in TRUSTED_PLUGIN_LIBRARIES
        val vendorRequest = resourceName == "cordis" && (referrerIsInternal || referrerIsPlugin) ||
            resourceName == "cosmokit" && referrerIsInternal
        val internalRequest = referrerIsInternal && !resourceIsPlugin || vendorRequest || pluginLibraryRequest
        val module = try {
            if (internalRequest) {
                assetResolver.resolve(resourceName, referrerUrl)
            } else {
                moduleResolver?.resolve(resourceName, referrerUrl)
                    ?: emptyRuntimePluginManifest(resourceName, referrerIsInternal)
                    ?: throw RuntimeEngineException(
                        RuntimeEngineErrorCode.MODULE_NOT_FOUND,
                        "The requested guest module was not found",
                    )
            }
        } catch (error: RuntimeEngineException) {
            moduleResolutionFailure = error
            return null
        } catch (_: Throwable) {
            moduleResolutionFailure = RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The guest module resolver failed",
            )
            return null
        }
        return try {
            validateExternalModule(module, allowInternal = internalRequest)
            module
        } catch (error: RuntimeEngineException) {
            moduleResolutionFailure = error
            null
        }
    }

    private fun resolveSyntheticModule(v8Runtime: V8Runtime, specifier: String): IV8Module? {
        moduleCache[specifier]?.let { return it }
        val registry = syntheticModuleRegistry
        if (registry == null) {
            moduleResolutionFailure = RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The runtime synthetic module registry is unavailable",
            )
            return null
        }
        return try {
            val binding = registry.get<V8ValueObject>(specifier) ?: throw IllegalArgumentException()
            try {
                val namespace = binding.get<V8ValueObject>("namespace") ?: throw IllegalArgumentException()
                try {
                    v8Runtime.createV8Module(specifier, namespace).also { moduleCache[specifier] = it }
                } finally {
                    namespace.close()
                }
            } finally {
                binding.close()
            }
        } catch (_: Throwable) {
            moduleResolutionFailure = RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_NOT_FOUND,
                "The requested synthetic module is unavailable",
            )
            null
        }
    }

    private fun validateExternalModule(module: RuntimeModuleSource, allowInternal: Boolean) {
        val resourceUri = runCatching { URI(module.resourceUrl) }.getOrNull()
        val scheme = resourceUri?.scheme
        if (
            module.source.isBlank() ||
            module.source.toByteArray(Charsets.UTF_8).size > MAX_EXTERNAL_MODULE_BYTES ||
            resourceUri?.isAbsolute != true ||
            scheme.isNullOrBlank() ||
            scheme.equals(NODE_SCHEME, ignoreCase = true) ||
            scheme.equals(HOLO_SCHEME, ignoreCase = true) ||
            (!allowInternal && scheme.equals(INTERNAL_SCHEME, ignoreCase = true))
        ) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The resolved guest module is invalid",
            )
        }
    }

    private fun hasScheme(value: String, scheme: String): Boolean =
        runCatching { URI(value).scheme?.equals(scheme, ignoreCase = true) == true }
            .getOrDefault(false)

    private fun runHostTurn() {
        threadGuard.checkAccess()
        val driver = turnDriver ?: throw RuntimeEngineException(
            RuntimeEngineErrorCode.INTERNAL,
            "The runtime turn driver is unavailable",
        )
        driver.callVoid(runtime.globalObject, *emptyArray<Any>())
        drainMicrotasks()
    }

    private fun runNativeTimer(timerId: Long) {
        threadGuard.checkAccess()
        val driver = timerDriver ?: return
        // JS timer identifiers are Numbers. Passing a Kotlin Long lets the
        // bridge represent it as a BigInt on some Javet/V8 combinations,
        // which the bounded JS timer registry correctly rejects.
        driver.callVoid(runtime.globalObject, timerId.toDouble())
        checkpointRequested = true
        drainMicrotasks()
    }

    private fun enqueueNativeEvent(
        callToken: String,
        requestId: String,
        event: RuntimeNativeEvent,
    ) {
        if (closed.get()) return
        val admitted = runCatching {
            require(event.eventJson.toByteArray(Charsets.UTF_8).size <= MAX_NATIVE_EVENT_JSON_BYTES)
            require(JSONObject(event.eventJson).getString("id") == requestId)
            require(event.binary.size <= MAX_NATIVE_BINARY_HANDLES)
            var totalBytes = 0L
            val handles = mutableSetOf<String>()
            val binary = event.binary.map { item ->
                require(NATIVE_HANDLE.matches(item.handle) && handles.add(item.handle))
                totalBytes += item.data.size
                require(totalBytes <= MAX_NATIVE_BINARY_BYTES)
                RuntimeNativeBinary(item.handle, item.data.copyOf())
            }
            RuntimeNativeEvent(event.eventJson, binary)
        }.getOrElse {
            RuntimeNativeEvent(internalNativeEvent(requestId))
        }
        host.requestRuntimeTask {
            if (!closed.get()) runNativeEvent(callToken, "event", admitted.eventJson, admitted.binary)
        }
    }

    private fun enqueueNativeResourceEvent(callToken: String, eventJson: String) {
        if (closed.get()) return
        val admitted = runCatching {
            require(eventJson.toByteArray(Charsets.UTF_8).size <= MAX_NATIVE_EVENT_JSON_BYTES)
            JSONObject(eventJson)
            eventJson
        }.getOrNull()
        host.requestRuntimeTask {
            if (!closed.get()) {
                runNativeEvent(
                    callToken,
                    if (admitted == null) "transport-failure" else "resource",
                    admitted ?: "{}",
                    emptyList(),
                )
            }
        }
    }

    private fun runNativeEvent(
        callToken: String,
        channel: String,
        eventJson: String,
        binary: List<RuntimeNativeBinary>,
    ) {
        threadGuard.checkAccess()
        val driver = nativeDriver ?: return
        runtime.createV8ValueArray().use { handles ->
            runtime.createV8ValueArray().use { values ->
                val typedValues = mutableListOf<V8ValueTypedArray>()
                try {
                    for (item in binary) {
                        handles.push(item.handle)
                        val typed = runtime.createV8ValueTypedArray(V8ValueType.Uint8Array, item.data.size)
                        typed.fromBytes(item.data)
                        typedValues += typed
                        values.push(typed)
                    }
                    driver.callVoid(runtime.globalObject, callToken, channel, eventJson, handles, values)
                    checkpointRequested = true
                    drainMicrotasks()
                } finally {
                    typedValues.forEach { typed -> runCatching { typed.close() } }
                }
            }
        }
    }

    private fun readNativeBinary(
        handles: V8ValueArray,
        values: V8ValueArray,
    ): List<RuntimeNativeBinary> {
        val length = handles.length
        require(length == values.length && length <= MAX_NATIVE_BINARY_HANDLES)
        var totalBytes = 0L
        return List(length) { index ->
            val handle = handles.getString(index)
            require(NATIVE_HANDLE.matches(handle))
            values.get<V8ValueTypedArray>(index).use { typed ->
                require(typed.type == V8ValueType.Uint8Array)
                val data = typed.toBytes()
                totalBytes += data.size
                require(totalBytes <= MAX_NATIVE_BINARY_BYTES)
                RuntimeNativeBinary(handle, data)
            }
        }
    }

    private fun drainMicrotasks() {
        if (!checkpointRequested) return
        checkpointRequested = false
        runtime.await(V8AwaitMode.RunTillNoMoreTasks)
    }

    private fun awaitRuntimeReadiness(readiness: V8Value) {
        if (readiness !is V8ValuePromise) return
        readiness.markAsHandled()
        var checkpoints = 0
        while (readiness.isPending && checkpoints < MAX_BOOTSTRAP_READINESS_CHECKPOINTS) {
            runtime.await(V8AwaitMode.RunTillNoMoreTasks)
            checkpoints += 1
        }
        if (readiness.isRejected) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.INTERNAL,
                "The runtime bootstrap readiness promise was rejected",
            )
        }
        if (readiness.isPending) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.INTERNAL,
                "The runtime bootstrap readiness promise did not settle",
            )
        }
    }

    private fun closeNativeHost() {
        if (nativeHostClosed.compareAndSet(false, true)) runCatching { nativeHost.close() }
    }

    private fun emptyRuntimePluginManifest(resourceName: String, referrerIsInternal: Boolean): RuntimeModuleSource? =
        if (referrerIsInternal && resourceName == RUNTIME_PLUGIN_MANIFEST_URL) {
            RuntimeModuleSource(RUNTIME_PLUGIN_MANIFEST_URL, EMPTY_RUNTIME_PLUGIN_MANIFEST_SOURCE)
        } else {
            null
        }

    private fun evaluationEnvelopeScript(source: String): String =
        """
        (() => {
          const value = (0, eval)(${JSONObject.quote(source)});
          if (value === undefined) return JSON.stringify({ type: "undefined" });
          if (value === null) return JSON.stringify({ type: "null" });
          const valueType = typeof value;
          if (valueType === "boolean") return JSON.stringify({ type: "boolean", value: String(value) });
          if (valueType === "number") return JSON.stringify({ type: "number", value: String(value) });
          if (valueType === "string") return JSON.stringify({ type: "string", value });
          if (valueType === "bigint") return JSON.stringify({ type: "bigint", value: String(value) });
          try {
            const json = JSON.stringify(value);
            if (json !== undefined) return JSON.stringify({ type: "json", value: json });
          } catch (_) {}
          return JSON.stringify({ type: "opaque", value: String(value) });
        })()
        """.trimIndent()

    private fun parseEvaluationEnvelope(envelopeJson: String): RuntimeEvaluation {
        val envelope = JSONObject(envelopeJson)
        val value = envelope.takeIf { it.has("value") }?.getString("value")
        val kind = when (envelope.getString("type")) {
            "undefined" -> RuntimeEvaluation.Kind.UNDEFINED
            "null" -> RuntimeEvaluation.Kind.NULL
            "boolean" -> RuntimeEvaluation.Kind.BOOLEAN
            "number" -> RuntimeEvaluation.Kind.NUMBER
            "string" -> RuntimeEvaluation.Kind.STRING
            "bigint" -> RuntimeEvaluation.Kind.BIGINT
            "json" -> RuntimeEvaluation.Kind.JSON
            else -> RuntimeEvaluation.Kind.OPAQUE
        }
        return RuntimeEvaluation(kind = kind, value = value)
    }

    private fun validateCapabilityJson(value: String) {
        require(value.toByteArray(Charsets.UTF_8).size <= MAX_CAPABILITY_JSON_BYTES)
        JSONObject(value)
    }

    private fun validateCapabilityTerminal(value: String?): String {
        val terminal = value ?: CAPABILITY_UNAVAILABLE_TERMINAL
        require(terminal.toByteArray(Charsets.UTF_8).size <= MAX_CAPABILITY_JSON_BYTES)
        JSONObject(terminal)
        return terminal
    }

    private inner class HostCallbacks {
        @V8Function
        fun architecture(): String = runtimeArchitecture

        @V8Function
        fun capabilityConfiguration(): String? = capabilityHost?.let { capability ->
            runCatching { capability.configurationJson() }
                .mapCatching { value ->
                    require(value.toByteArray(Charsets.UTF_8).size <= MAX_CAPABILITY_JSON_BYTES)
                    JSONObject(value)
                    value
                }
                .getOrNull()
        }

        @V8Function
        fun capabilityInvoke(requestJson: String, initiallyAborted: Boolean): String {
            validateCapabilityJson(requestJson)
            return validateCapabilityTerminal(pluginHost?.invoke(requestJson, initiallyAborted))
        }

        @V8Function
        fun capabilityInvokeImmediate(requestJson: String): String {
            validateCapabilityJson(requestJson)
            return validateCapabilityTerminal(pluginHost?.invokeImmediate(requestJson))
        }

        @V8Function
        fun capabilityInvokeSync(requestJson: String): String {
            validateCapabilityJson(requestJson)
            return validateCapabilityTerminal(pluginHost?.invokeSync(requestJson))
        }

        @V8Function
        fun capabilityInvokeFromSource(channel: String, requestJson: String): String {
            validateCapabilityJson(requestJson)
            return validateCapabilityTerminal(pluginHost?.invokeFromSource(channel, requestJson))
        }

        @V8Function
        fun capabilityClose(): Boolean {
            pluginHost?.closeCapabilityRuntime()
            return pluginHost != null
        }

        @V8Function
        fun capabilityReleaseResource(bindingId: String): Boolean {
            require(CAPABILITY_BINDING_ID.matches(bindingId))
            return pluginHost?.releaseResource(bindingId) == true
        }

        @V8Function
        fun capabilitySubscribeResource(bindingId: String, callback: V8ValueFunction): String? {
            require(CAPABILITY_BINDING_ID.matches(bindingId))
            val capability = pluginHost ?: return null
            val persistent: V8ValueFunction = callback.toClone(true)
            val id = "capability-subscription-${nextCapabilitySubscriptionId++}"
            val pending = ArrayDeque<String>()
            val ready = AtomicBoolean(false)
            fun deliver(eventJson: String) {
                if (eventJson.toByteArray(Charsets.UTF_8).size > MAX_CAPABILITY_JSON_BYTES) return
                synchronized(pending) {
                    if (!ready.get()) {
                        pending.addLast(eventJson)
                        return
                    }
                }
                host.requestRuntimeTask {
                    if (closed.get() || !capabilitySubscriptions.containsKey(id)) return@requestRuntimeTask
                    runCatching { JSONObject(eventJson) }.onSuccess {
                        persistent.callVoid(runtime.globalObject, eventJson)
                        repeat(8) { runtime.await(V8AwaitMode.RunNoWait) }
                    }
                }
            }
            val native = capability.subscribeResource(
                bindingId,
                RuntimeCapabilityResourceEventSink(::deliver),
            ) ?: run {
                persistent.close()
                return null
            }
            capabilitySubscriptions[id] = CapabilitySubscription(persistent, native)
            val buffered = synchronized(pending) {
                ready.set(true)
                pending.toList().also { pending.clear() }
            }
            buffered.forEach(::deliver)
            return id
        }

        @V8Function
        fun capabilityUnsubscribeResource(subscriptionId: String): Boolean {
            val subscription = capabilitySubscriptions.remove(subscriptionId) ?: return false
            runCatching { subscription.native.close() }
            runCatching { subscription.callback.close() }
            return true
        }

        @V8Function
        fun processConfiguration(): String = JSONObject().apply {
            put("argv", processHost.configuration.argv)
            put("cwd", processHost.configuration.cwd)
            put("env", JSONObject(processHost.configuration.env))
            put("execPath", processHost.configuration.execPath)
            put("pid", processHost.configuration.pid)
        }.toString()

        @V8Function
        fun runtimePlugins(): String = processHost.configuration.runtimePluginsJson

        @V8Function
        fun nativeConfiguration(): String = runCatching { nativeHost.configurationJson() }
            .mapCatching { value ->
                require(value.toByteArray(Charsets.UTF_8).size <= MAX_NATIVE_CONFIGURATION_BYTES)
                JSONObject(value)
                value
            }
            .getOrDefault("{\"capabilities\":[]}")

        @V8Function
        fun networkDiagnostic(eventJson: String) {
            if (eventJson.toByteArray(Charsets.UTF_8).size > MAX_NETWORK_DIAGNOSTIC_BYTES) return
            runCatching {
                diagnosticsExecutor.execute {
                    runCatching { JSONObject(eventJson) }
                        .onSuccess { runCatching { processHost.networkDiagnostic(eventJson) } }
                }
            }
        }

        @V8Function
        fun sha256Hex(value: V8ValueTypedArray): String {
            require(value.type == V8ValueType.Uint8Array)
            val bytes = value.toBytes()
            require(bytes.size.toLong() <= MAX_NATIVE_BINARY_BYTES)
            return MessageDigest.getInstance("SHA-256").apply { update(bytes) }.digest().toHex()
        }

        @V8Function
        fun sha256HexChunks(values: V8ValueArray): String {
            require(values.length <= MAX_NATIVE_BODY_CHUNKS)
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            for (index in 0 until values.length) {
                values.get<V8ValueTypedArray>(index).use { typed ->
                    require(typed.type == V8ValueType.Uint8Array)
                    val bytes = typed.toBytes()
                    total += bytes.size
                    require(total <= MAX_NATIVE_BINARY_BYTES)
                    digest.update(bytes)
                }
            }
            return digest.digest().toHex()
        }

        @V8Function
        fun writeOutput(stream: String, chunk: String): Boolean {
            val output = if (stream == "stderr") RuntimeOutputStream.STDERR else RuntimeOutputStream.STDOUT
            processHost.write(output, chunk)
            return true
        }

        @V8Function
        fun exit(code: Int) {
            if (code !in 0..255) return
            processHost.exit(code)
            host.requestTermination()
        }

        @V8Function
        fun scheduleTimer(delayMs: Double, intervalMs: Double?): Double {
            if (
                !delayMs.isFinite() || delayMs < 0.0 || delayMs > Long.MAX_VALUE ||
                (intervalMs != null && (!intervalMs.isFinite() || intervalMs < 0.0 || intervalMs > Long.MAX_VALUE))
            ) throw IllegalArgumentException("Invalid timer delay")
            return host.scheduleTimer(delayMs.toLong(), intervalMs?.toLong(), ::runNativeTimer).toDouble()
        }

        @V8Function
        fun cancelTimer(timerId: Double): Boolean {
            if (!timerId.isFinite() || timerId <= 0.0 || timerId > Long.MAX_VALUE) return false
            return host.cancelTimer(timerId.toLong())
        }

        @V8Function
        fun installSyntheticModules(modules: V8ValueObject) {
            threadGuard.checkAccess()
            syntheticModuleRegistry?.close()
            syntheticModuleRegistry = modules.toClone(true)
        }

        @V8Function
        fun nativeDispatch(
            callToken: String,
            requestId: String,
            requestJson: String,
            contextJson: String,
            binaryHandles: V8ValueArray,
            binaryValues: V8ValueArray,
        ) {
            threadGuard.checkAccess()
            val sink = RuntimeNativeEventSink { event -> enqueueNativeEvent(callToken, requestId, event) }
            val resourceSink = RuntimeNativeResourceEventSink { event ->
                enqueueNativeResourceEvent(callToken, event)
            }
            runCatching {
                require(NATIVE_CALL_TOKEN.matches(callToken) && NATIVE_REQUEST_ID.matches(requestId))
                require(requestJson.toByteArray(Charsets.UTF_8).size <= MAX_NATIVE_REQUEST_JSON_BYTES)
                require(contextJson.toByteArray(Charsets.UTF_8).size <= MAX_NATIVE_CONTEXT_JSON_BYTES)
                JSONObject(requestJson)
                JSONObject(contextJson)
                nativeHost.dispatch(
                    requestId,
                    requestJson,
                    contextJson,
                    readNativeBinary(binaryHandles, binaryValues),
                    sink,
                    resourceSink,
                )
            }.onFailure {
                sink.emit(RuntimeNativeEvent(internalNativeEvent(requestId)))
            }
        }

        @V8Function
        fun nativeCancel(callToken: String, reason: String?) {
            if (NATIVE_CALL_TOKEN.matches(callToken)) runCatching { nativeHost.cancel(callToken, reason) }
        }

        @V8Function
        fun nativeCloseResource(ownerCallToken: String, providerToken: String, reason: String?) {
            if (NATIVE_CALL_TOKEN.matches(ownerCallToken) && NATIVE_PROVIDER_TOKEN.matches(providerToken)) {
                runCatching { nativeHost.closeResource(ownerCallToken, providerToken, reason) }
            }
        }

        @V8Function
        fun nativeGrantCredits(callToken: String, credits: Int) {
            if (NATIVE_CALL_TOKEN.matches(callToken) && credits > 0) {
                runCatching { nativeHost.grantCredits(callToken, credits) }
            }
        }

        @V8Function
        fun nativeDispose() {
            closeNativeHost()
        }

        @V8Function
        fun now(): Double = SystemClock.elapsedRealtime().toDouble()

        @V8Function
        fun readAsset(path: String): String? = assetResolver.readGuestAssetJson(path)

        @V8Function
        fun requestWakeup(deadlineMs: Double?) {
            threadGuard.checkAccess()
            if (deadlineMs != null && (!deadlineMs.isFinite() || deadlineMs < 0.0 || deadlineMs > Long.MAX_VALUE)) {
                host.requestTermination()
                return
            }
            host.requestWakeup(
                deadlineMs = deadlineMs?.toLong(),
                observedNowMs = SystemClock.elapsedRealtime(),
                callback = ::runHostTurn,
            )
        }

        @V8Function
        fun checkpointMicrotasks() {
            threadGuard.checkAccess()
            checkpointRequested = true
        }

        @V8Function
        fun terminate(reasonJson: String) {
            threadGuard.checkAccess()
            if (reasonJson.toByteArray(Charsets.UTF_8).size > MAX_TERMINATION_REASON_BYTES) {
                host.requestTermination()
                return
            }
            runCatching { JSONObject(reasonJson) }
            host.requestTermination()
        }
    }

    private companion object {
        private val CAPABILITY_BINDING_ID = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,159}")
        private const val HOST_GLOBAL = "__oneworksAndroidHost"
        private const val INTERNAL_SCHEME = "holonomy"
        private const val PLUGIN_SCHEME = "holo-plugins"
        private const val RUNTIME_PLUGIN_MANIFEST_URL = "holo-plugins:///manifest.mjs"
        private val TRUSTED_PLUGIN_LIBRARIES = setOf(
            "@holonomyjs/plugin-audit",
            "@holonomyjs/plugin-permission",
        )
        private const val EMPTY_RUNTIME_PLUGIN_MANIFEST_SOURCE =
            "export const runtimePluginNamespaces=Object.freeze({});"
        private const val HOLO_SCHEME = "holo"
        private const val MAX_CAPABILITY_JSON_BYTES = 1024 * 1024
        private const val MAX_BOOTSTRAP_READINESS_CHECKPOINTS = 1024
        private const val MAX_NATIVE_BINARY_BYTES = 8 * 1024 * 1024L
        private const val MAX_NATIVE_BINARY_HANDLES = 16
        private const val MAX_NATIVE_BODY_CHUNKS = 4096
        private const val MAX_NATIVE_CONFIGURATION_BYTES = 64 * 1024
        private const val MAX_NATIVE_CONTEXT_JSON_BYTES = 64 * 1024
        private const val MAX_NATIVE_EVENT_JSON_BYTES = 256 * 1024
        private const val MAX_NATIVE_REQUEST_JSON_BYTES = 256 * 1024
        private const val MAX_EXTERNAL_MODULE_BYTES = 8 * 1024 * 1024
        private const val MAX_TERMINATION_REASON_BYTES = 4 * 1024
        private const val TURN_DRIVER_GLOBAL = "__oneworksAndroidTurn"
        private const val TIMER_DRIVER_GLOBAL = "__oneworksAndroidTimer"
        private const val NATIVE_DRIVER_GLOBAL = "__oneworksAndroidNative"
        private const val CONTROL_DRIVER_GLOBAL = "__oneworksHolonomyControl"
        private const val TRUSTED_BACKEND_DRIVER_GLOBAL = "__oneworksAndroidTrustedBackend"
        private const val READY_DRIVER_GLOBAL = "__oneworksAndroidReady"
        private const val MAX_NETWORK_DIAGNOSTIC_BYTES = 512 * 1024
        private const val MAX_PENDING_NETWORK_DIAGNOSTICS = 256
        private const val NODE_SCHEME = "node"
        private const val CAPABILITY_UNAVAILABLE_TERMINAL =
            "{\"ok\":false,\"error\":{\"name\":\"Error\",\"code\":\"holo.capability_unsupported\"," +
                "\"message\":\"Capability unavailable\",\"retryable\":false}}"
        private val NATIVE_CALL_TOKEN = Regex("^[A-Za-z0-9:._-]{1,128}$")
        private val NATIVE_HANDLE = Regex("^[A-Za-z0-9:._-]{1,128}$")
        private val NATIVE_PROVIDER_TOKEN = Regex("^[A-Za-z0-9:._-]{1,128}$")
        private val NATIVE_REQUEST_ID = Regex("^[A-Za-z0-9:._-]{1,128}$")

        private fun internalNativeEvent(requestId: String): String =
            "{\"id\":${JSONObject.quote(requestId)},\"type\":\"error\"," +
                "\"error\":{\"domain\":\"runtime\",\"code\":\"internal\"}}"

        private fun ByteArray.toHex(): String {
            val alphabet = "0123456789abcdef"
            return buildString(size * 2) {
                for (byte in this@toHex) {
                    val value = byte.toInt() and 0xFF
                    append(alphabet[value ushr 4])
                    append(alphabet[value and 0x0F])
                }
            }
        }
    }

    private data class CapabilitySubscription(
        val callback: V8ValueFunction,
        val native: AutoCloseable,
    )
}
