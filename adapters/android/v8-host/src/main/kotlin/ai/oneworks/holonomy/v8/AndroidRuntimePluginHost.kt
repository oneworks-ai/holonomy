package ai.oneworks.holonomy.v8

import android.content.res.AssetManager
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeEngineException
import ai.oneworks.holonomy.host.RuntimeAdapterHost
import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.host.RuntimeThreadGuard
import com.caoccao.javet.annotations.V8Function
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.entities.JavetEntityError
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.interop.callback.IV8ModuleResolver
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.reference.IV8Module
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValueObject
import com.caoccao.javet.values.reference.V8ValuePromise
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONArray
import org.json.JSONObject

/** Host-owned Realm for configured Cordis plugins. No value from this Realm enters the Guest Realm. */
internal class AndroidRuntimePluginHost(
    assets: AssetManager,
    private val capabilityHost: RuntimeCapabilityHost?,
    private val moduleResolver: RuntimeModuleResolver?,
    private val processHost: RuntimeProcessHost,
    private val runtimeHost: RuntimeAdapterHost,
    private val threadGuard: RuntimeThreadGuard,
) : AutoCloseable {
    private val assetResolver = AndroidAssetModuleResolver(assets)
    private val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
    private val callbacks = PluginHostCallbacks()
    private val hostObject: V8ValueObject
    private val modules = mutableMapOf<String, IV8Module>()
    private var resolutionFailure: RuntimeEngineException? = null
    private var disposeDriver: V8ValueFunction? = null
    private var capabilityCloseDriver: V8ValueFunction? = null
    private var capabilityInvokeDriver: V8ValueFunction? = null
    private var capabilityInvokeFromSourceDriver: V8ValueFunction? = null
    private var capabilityInvokeImmediateDriver: V8ValueFunction? = null
    private var capabilityInvokeSyncDriver: V8ValueFunction? = null
    private var capabilityReleaseResourceDriver: V8ValueFunction? = null
    private var capabilitySubscribeResourceDriver: V8ValueFunction? = null
    private var capabilityUnsubscribeResourceDriver: V8ValueFunction? = null
    private var timerDriver: V8ValueFunction? = null
    private val providerSubscriptions = mutableMapOf<String, CapabilitySubscription>()
    private val guestResourceSinks = mutableMapOf<String, RuntimeCapabilityResourceEventSink>()
    private val guestResourceDisposers = mutableMapOf<String, V8ValueFunction>()
    private val nextProviderSubscriptionId = AtomicLong(1)
    private val nextGuestSubscriptionId = AtomicLong(1)
    private val closed = AtomicBoolean(false)
    private var started = false

    init {
        threadGuard.checkAccess()
        hostObject = runtime.createV8ValueObject()
        hostObject.bind(callbacks)
        runtime.globalObject.set(HOST_GLOBAL, hostObject)
        installModuleResolver()
    }

    fun start() {
        threadGuard.checkAccess()
        if (started) return
        try {
            val bootstrap = assetResolver.resolve(BOOTSTRAP_URL, null)
            val module = compile(bootstrap)
            val evaluation = module.execute<V8Value>(true)
            await(evaluation)
            resolutionFailure?.let { throw it }
            disposeDriver = takeDriver(DISPOSE_GLOBAL, "plugin disposer")
            capabilityCloseDriver = takeDriver(CAPABILITY_CLOSE_GLOBAL, "Capability close")
            capabilityInvokeDriver = takeDriver(CAPABILITY_INVOKE_GLOBAL, "Capability invoke")
            capabilityInvokeFromSourceDriver = takeDriver(
                CAPABILITY_INVOKE_FROM_SOURCE_GLOBAL,
                "Capability source invoke",
            )
            capabilityInvokeImmediateDriver = takeDriver(
                CAPABILITY_INVOKE_IMMEDIATE_GLOBAL,
                "Capability immediate invoke",
            )
            capabilityInvokeSyncDriver = takeDriver(CAPABILITY_INVOKE_SYNC_GLOBAL, "Capability sync invoke")
            capabilityReleaseResourceDriver = takeDriver(
                CAPABILITY_RELEASE_RESOURCE_GLOBAL,
                "Capability resource release",
            )
            capabilitySubscribeResourceDriver = takeDriver(
                CAPABILITY_SUBSCRIBE_RESOURCE_GLOBAL,
                "Capability resource subscribe",
            )
            capabilityUnsubscribeResourceDriver = takeDriver(
                CAPABILITY_UNSUBSCRIBE_RESOURCE_GLOBAL,
                "Capability resource unsubscribe",
            )
            timerDriver = takeDriver(TIMER_DRIVER_GLOBAL, "plugin timer")
            runtime.globalObject.delete(HOST_GLOBAL)
            started = true
        } catch (error: Throwable) {
            processHost.write(
                RuntimeOutputStream.STDERR,
                "Android Runtime plugin start failed: ${error::class.simpleName}:${error.message}\n"
                    .take(MAX_OUTPUT_CHARS),
            )
            close()
            throw resolutionFailure ?: error
        }
    }

    fun invoke(requestJson: String, initiallyAborted: Boolean): String {
        threadGuard.checkAccess()
        requireStarted()
        return requireNotNull(capabilityInvokeDriver).callString(
            runtime.globalObject,
            requestJson,
            initiallyAborted,
        )
    }

    fun invokeImmediate(requestJson: String): String {
        threadGuard.checkAccess()
        requireStarted()
        return requireNotNull(capabilityInvokeImmediateDriver).callString(runtime.globalObject, requestJson)
    }

    fun invokeSync(requestJson: String): String {
        threadGuard.checkAccess()
        requireStarted()
        return requireNotNull(capabilityInvokeSyncDriver).callString(runtime.globalObject, requestJson)
    }

    fun invokeFromSource(channel: String, requestJson: String): String {
        threadGuard.checkAccess()
        require(
            channel == "linuxFilesystem" || channel == "linuxCapability" ||
                channel == "linuxProcessExecution" || channel == "linuxProcessNetwork",
        )
        requireStarted()
        return awaitString(
            requireNotNull(capabilityInvokeFromSourceDriver).call<V8Value>(
                runtime.globalObject,
                channel,
                requestJson,
            ),
        )
    }

    fun releaseResource(bindingId: String): Boolean {
        threadGuard.checkAccess()
        if (!started || closed.get()) return false
        return requireNotNull(capabilityReleaseResourceDriver).callBoolean(runtime.globalObject, bindingId)
    }

    fun subscribeResource(
        bindingId: String,
        sink: RuntimeCapabilityResourceEventSink,
    ): AutoCloseable? {
        threadGuard.checkAccess()
        if (!started || closed.get()) return null
        val subscriptionId = "capability-guest-${nextGuestSubscriptionId.getAndIncrement()}"
        guestResourceSinks[subscriptionId] = sink
        val subscribed = runCatching {
            requireNotNull(capabilitySubscribeResourceDriver).callBoolean(
                runtime.globalObject,
                bindingId,
                subscriptionId,
            )
        }.getOrDefault(false)
        if (!subscribed || !guestResourceDisposers.containsKey(subscriptionId)) {
            guestResourceSinks.remove(subscriptionId)
            guestResourceDisposers.remove(subscriptionId)?.close()
            return null
        }
        return AutoCloseable {
            runtimeHost.requestRuntimeTask {
                if (!closed.get()) unsubscribeGuestResource(subscriptionId)
            }
        }
    }

    fun closeCapabilityRuntime() {
        threadGuard.checkAccess()
        if (!started || closed.get()) return
        runCatching { capabilityCloseDriver?.callVoid(runtime.globalObject, *emptyArray<Any>()) }
    }

    override fun close() {
        threadGuard.checkAccess()
        if (!closed.compareAndSet(false, true)) return
        runCatching {
            disposeDriver?.call<V8Value>(runtime.globalObject, *emptyArray<Any>())?.let(::await)
        }
        guestResourceDisposers.values.forEach { disposer -> runCatching { disposer.close() } }
        guestResourceDisposers.clear()
        guestResourceSinks.clear()
        providerSubscriptions.values.forEach { subscription ->
            runCatching { subscription.native.close() }
            runCatching { subscription.callback.close() }
        }
        providerSubscriptions.clear()
        listOf(
            capabilityCloseDriver,
            capabilityInvokeDriver,
            capabilityInvokeFromSourceDriver,
            capabilityInvokeImmediateDriver,
            capabilityInvokeSyncDriver,
            capabilityReleaseResourceDriver,
            capabilitySubscribeResourceDriver,
            capabilityUnsubscribeResourceDriver,
            disposeDriver,
        ).forEach { driver -> runCatching { driver?.close() } }
        capabilityCloseDriver = null
        capabilityInvokeDriver = null
        capabilityInvokeFromSourceDriver = null
        capabilityInvokeImmediateDriver = null
        capabilityInvokeSyncDriver = null
        capabilityReleaseResourceDriver = null
        capabilitySubscribeResourceDriver = null
        capabilityUnsubscribeResourceDriver = null
        timerDriver = null
        disposeDriver = null
        runCatching { hostObject.unbind(callbacks) }
        runCatching { hostObject.close() }
        modules.clear()
        runCatching { runtime.close() }
    }

    private fun awaitString(value: V8Value): String {
        try {
            if (value !is V8ValuePromise) throw RuntimeEngineException(
                RuntimeEngineErrorCode.INTERNAL,
                "The Android Host Capability invocation did not return a Promise",
            )
            value.markAsHandled()
            var checkpoints = 0
            while (value.isPending && checkpoints < MAX_CAPABILITY_CHECKPOINTS) {
                runtime.await(V8AwaitMode.RunTillNoMoreTasks)
                checkpoints += 1
            }
            if (!value.isFulfilled) throw RuntimeEngineException(
                RuntimeEngineErrorCode.INTERNAL,
                "The Android Host Capability invocation did not settle",
            )
            return value.getResultString()
        } finally {
            runCatching { value.close() }
        }
    }

    private fun requireStarted() {
        check(started && !closed.get()) { "Android Runtime plugin Host is unavailable" }
    }

    private fun runPluginTimer(timerId: Long) {
        threadGuard.checkAccess()
        if (closed.get()) return
        timerDriver?.callVoid(runtime.globalObject, timerId.toDouble())
        repeat(8) { runtime.await(V8AwaitMode.RunNoWait) }
    }

    private fun takeDriver(name: String, label: String): V8ValueFunction =
        runtime.globalObject.get<V8ValueFunction>(name)
            ?.also { runtime.globalObject.delete(name) }
            ?: throw RuntimeEngineException(
                RuntimeEngineErrorCode.INTERNAL,
                "The Android $label driver was not installed",
            )

    private fun unsubscribeGuestResource(subscriptionId: String): Boolean {
        val result = runCatching {
            capabilityUnsubscribeResourceDriver?.callBoolean(runtime.globalObject, subscriptionId) == true
        }.getOrDefault(false)
        disposeGuestResourceSubscription(subscriptionId)
        return result
    }

    private fun disposeGuestResourceSubscription(subscriptionId: String): Boolean {
        val existed = guestResourceSinks.remove(subscriptionId) != null
        guestResourceDisposers.remove(subscriptionId)?.let { disposer ->
            runCatching { disposer.callVoid(runtime.globalObject, *emptyArray<Any>()) }
            runCatching { disposer.close() }
        }
        return existed
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
                    val referrer = runCatching { v8ModuleReferrer.resourceName }.getOrNull()
                    val source = resolveSource(resourceName, referrer) ?: return null
                    modules[source.resourceUrl]?.let { return it }
                    return runCatching { compile(source) }.getOrElse {
                        resolutionFailure = RuntimeEngineException(
                            RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                            "The Android Runtime plugin module could not be compiled",
                        )
                        null
                    }
                }
            },
        )
    }

    private fun resolveSource(specifier: String, referrer: String?): RuntimeModuleSource? {
        val referrerInternal = referrer.hasScheme(INTERNAL_SCHEME)
        val referrerPlugin = referrer.hasScheme(PLUGIN_SCHEME)
        val resourcePlugin = specifier.hasScheme(PLUGIN_SCHEME)
        val trustedLibrary = referrerPlugin && specifier in TRUSTED_PLUGIN_LIBRARIES
        return try {
            when {
                resourcePlugin || referrerPlugin && !trustedLibrary ->
                    moduleResolver?.resolve(specifier, referrer)
                referrerInternal || trustedLibrary || specifier == "cordis" ->
                    assetResolver.resolve(specifier, referrer)
                else -> null
            }?.also(::validateModule)
        } catch (error: RuntimeEngineException) {
            resolutionFailure = error
            null
        } catch (_: Throwable) {
            resolutionFailure = RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The Android Runtime plugin resolver failed",
            )
            null
        }
    }

    private fun compile(module: RuntimeModuleSource): IV8Module =
        runtime.getExecutor(sourceWithImportMeta(module.resourceUrl, module.source))
            .setModule(true)
            .setResourceName(module.resourceUrl)
            .compileV8Module()
            .also { modules[module.resourceUrl] = it }

    private fun await(value: V8Value) {
        try {
            if (value !is V8ValuePromise) return
            value.markAsHandled()
            var checkpoints = 0
            while (value.isPending && checkpoints < MAX_PLUGIN_BOOTSTRAP_CHECKPOINTS) {
                runtime.await(V8AwaitMode.RunTillNoMoreTasks)
                checkpoints += 1
            }
            if (value.isRejected) {
                val reason = runCatching {
                    when (val result = value.getResultObject<Any?>()) {
                        is JavetEntityError -> listOfNotNull(
                            result.message,
                            result.detailedMessage,
                            result.stack,
                        ).distinct().joinToString("\n")
                        else -> result?.toString()
                    }
                }.getOrNull()?.take(MAX_OUTPUT_CHARS) ?: "unknown rejection"
                throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The Android Runtime plugin lifecycle was rejected: $reason",
                )
            }
            if (value.isPending) {
                throw RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The Android Runtime plugin lifecycle did not settle",
                )
            }
        } finally {
            runCatching { value.close() }
        }
    }

    private fun validateModule(module: RuntimeModuleSource) {
        val uri = runCatching { URI(module.resourceUrl) }.getOrNull()
        if (
            module.source.isBlank() || module.source.toByteArray(Charsets.UTF_8).size > MAX_SOURCE_BYTES ||
            uri?.isAbsolute != true || uri.scheme !in setOf(INTERNAL_SCHEME, PLUGIN_SCHEME)
        ) throw RuntimeEngineException(
            RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
            "The Android Runtime plugin module is invalid",
        )
    }

    private fun sourceWithImportMeta(resourceUrl: String, source: String): String =
        "import.meta.url=${JSONObject.quote(resourceUrl)};$source"

    private fun String?.hasScheme(scheme: String): Boolean =
        this != null && runCatching { URI(this).scheme == scheme }.getOrDefault(false)

    private inner class PluginHostCallbacks {
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
        fun capabilityInvokeSync(requestJson: String): String {
            require(requestJson.toByteArray(Charsets.UTF_8).size <= MAX_CAPABILITY_JSON_BYTES)
            JSONObject(requestJson)
            val value = capabilityHost?.invokeSync(requestJson) ?: CAPABILITY_UNAVAILABLE_TERMINAL
            require(value.toByteArray(Charsets.UTF_8).size <= MAX_CAPABILITY_JSON_BYTES)
            JSONObject(value)
            return value
        }

        @V8Function
        fun capabilityReleaseResource(bindingId: String): Boolean {
            require(CAPABILITY_BINDING_ID.matches(bindingId))
            capabilityHost?.releaseResource(bindingId)
            return capabilityHost != null
        }

        @V8Function
        fun capabilitySubscribeResource(bindingId: String, callback: V8ValueFunction): String? {
            require(CAPABILITY_BINDING_ID.matches(bindingId))
            val capability = capabilityHost ?: return null
            val persistent: V8ValueFunction = callback.toClone(true)
            val id = "capability-provider-${nextProviderSubscriptionId.getAndIncrement()}"
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
                runtimeHost.requestRuntimeTask {
                    if (closed.get() || !providerSubscriptions.containsKey(id)) return@requestRuntimeTask
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
            providerSubscriptions[id] = CapabilitySubscription(persistent, native)
            val buffered = synchronized(pending) {
                ready.set(true)
                pending.toList().also { pending.clear() }
            }
            return JSONObject()
                .put("initialEvents", JSONArray(buffered.map(::JSONObject)))
                .put("subscriptionId", id)
                .toString()
        }

        @V8Function
        fun capabilityUnsubscribeResource(subscriptionId: String): Boolean {
            val subscription = providerSubscriptions.remove(subscriptionId) ?: return false
            runCatching { subscription.native.close() }
            runCatching { subscription.callback.close() }
            return true
        }

        @V8Function
        fun emitGuestResourceEvent(subscriptionId: String, eventJson: String) {
            require(eventJson.toByteArray(Charsets.UTF_8).size <= MAX_CAPABILITY_JSON_BYTES)
            JSONObject(eventJson)
            guestResourceSinks[subscriptionId]?.emit(eventJson)
        }

        @V8Function
        fun retainGuestResourceSubscription(subscriptionId: String, dispose: V8ValueFunction) {
            require(GUEST_SUBSCRIPTION_ID.matches(subscriptionId))
            check(!guestResourceDisposers.containsKey(subscriptionId))
            guestResourceDisposers[subscriptionId] = dispose.toClone(true)
        }

        @V8Function
        fun releaseGuestResourceSubscription(subscriptionId: String): Boolean =
            disposeGuestResourceSubscription(subscriptionId)

        @V8Function
        fun runtimePlugins(): String = processHost.configuration.runtimePluginsJson

        @V8Function
        fun scheduleTimer(delayMs: Double): Double {
            require(delayMs.isFinite() && delayMs >= 0.0 && delayMs <= Long.MAX_VALUE)
            return runtimeHost.scheduleTimer(delayMs.toLong(), null, ::runPluginTimer).toDouble()
        }

        @V8Function
        fun cancelTimer(timerId: Double): Boolean {
            if (!timerId.isFinite() || timerId <= 0.0 || timerId > Long.MAX_VALUE) return false
            return runtimeHost.cancelTimer(timerId.toLong())
        }

        @V8Function
        fun writeOutput(stream: String, chunk: String) {
            processHost.write(
                if (stream == "stderr") RuntimeOutputStream.STDERR else RuntimeOutputStream.STDOUT,
                chunk.take(MAX_OUTPUT_CHARS),
            )
        }
    }

    private companion object {
        private const val BOOTSTRAP_URL = "holonomy:///runtime/plugin-host.mjs"
        private const val CAPABILITY_CLOSE_GLOBAL = "__oneworksAndroidCapabilityClose"
        private const val CAPABILITY_INVOKE_FROM_SOURCE_GLOBAL = "__oneworksAndroidCapabilityInvokeFromSource"
        private const val CAPABILITY_INVOKE_GLOBAL = "__oneworksAndroidCapabilityInvoke"
        private const val CAPABILITY_INVOKE_IMMEDIATE_GLOBAL = "__oneworksAndroidCapabilityInvokeImmediate"
        private const val CAPABILITY_INVOKE_SYNC_GLOBAL = "__oneworksAndroidCapabilityInvokeSync"
        private const val CAPABILITY_RELEASE_RESOURCE_GLOBAL = "__oneworksAndroidCapabilityReleaseResource"
        private const val CAPABILITY_SUBSCRIBE_RESOURCE_GLOBAL = "__oneworksAndroidCapabilitySubscribeResource"
        private const val CAPABILITY_UNSUBSCRIBE_RESOURCE_GLOBAL =
            "__oneworksAndroidCapabilityUnsubscribeResource"
        private const val CAPABILITY_UNAVAILABLE_TERMINAL =
            "{\"error\":{\"code\":\"ERR_HOLO_CAPABILITY_UNSUPPORTED\",\"message\":\"Capability Runtime is unavailable\",\"name\":\"Error\",\"retryable\":false},\"ok\":false}"
        private const val DISPOSE_GLOBAL = "__oneworksAndroidPluginDispose"
        private const val HOST_GLOBAL = "__oneworksAndroidPluginHost"
        private const val INTERNAL_SCHEME = "holonomy"
        private const val TIMER_DRIVER_GLOBAL = "__oneworksAndroidPluginTimer"
        private const val MAX_CAPABILITY_CHECKPOINTS = 64
        private const val MAX_CAPABILITY_JSON_BYTES = 1024 * 1024
        private const val MAX_OUTPUT_CHARS = 65_536
        private const val MAX_PLUGIN_BOOTSTRAP_CHECKPOINTS = 64
        private const val MAX_SOURCE_BYTES = 8 * 1024 * 1024
        private const val PLUGIN_SCHEME = "holo-plugins"
        private val CAPABILITY_BINDING_ID = Regex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$")
        private val GUEST_SUBSCRIPTION_ID = Regex("^capability-guest-[1-9][0-9]{0,18}$")
        private val TRUSTED_PLUGIN_LIBRARIES = setOf(
            "@holonomyjs/plugin-audit",
            "@holonomyjs/plugin-permission",
            "cordis",
        )
    }

    private data class CapabilitySubscription(
        val callback: V8ValueFunction,
        val native: AutoCloseable,
    )
}
