package ai.oneworks.mobile.runtime.v8

import android.content.res.AssetManager
import android.os.SystemClock
import ai.oneworks.mobile.runtime.host.RuntimeAdapter
import ai.oneworks.mobile.runtime.host.RuntimeAdapterHost
import ai.oneworks.mobile.runtime.host.RuntimeEngineErrorCode
import ai.oneworks.mobile.runtime.host.RuntimeEngineException
import ai.oneworks.mobile.runtime.host.RuntimeEvaluation
import ai.oneworks.mobile.runtime.host.RuntimeNativeHost
import ai.oneworks.mobile.runtime.host.RuntimeThreadGuard
import com.caoccao.javet.annotations.V8Function
import com.caoccao.javet.enums.V8AwaitMode
import com.caoccao.javet.interop.V8Host
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.interop.callback.IV8ModuleResolver
import com.caoccao.javet.values.reference.IV8Module
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValueObject
import org.json.JSONObject

internal class JavetRuntimeAdapter(
    assets: AssetManager,
    private val bootstrapAssetPath: String,
    private val host: RuntimeAdapterHost,
    private val nativeHost: RuntimeNativeHost,
    private val runtimeArchitecture: String,
    private val threadGuard: RuntimeThreadGuard,
) : RuntimeAdapter {
    private val assetResolver = AndroidAssetModuleResolver(assets)
    private val runtime: V8Runtime = V8Host.getV8Instance().createV8Runtime()
    private val callbacks = HostCallbacks()
    private val hostObject: V8ValueObject
    private val moduleCache = mutableMapOf<String, IV8Module>()
    private var moduleResolutionFailure: RuntimeEngineException? = null
    private var checkpointRequested = false
    private var started = false
    private var turnDriver: V8ValueFunction? = null

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
        val bootstrap = assetResolver.resolve(
            "app:///$bootstrapAssetPath",
            null,
        )
        executeModule(bootstrap.resourceUrl, bootstrap.source)
        turnDriver = runtime.globalObject.get<V8ValueFunction>(TURN_DRIVER_GLOBAL)
            ?: throw RuntimeEngineException(
                RuntimeEngineErrorCode.INTERNAL,
                "The runtime turn driver was not installed",
            )
        runtime.globalObject.delete(TURN_DRIVER_GLOBAL)
        runtime.globalObject.delete(HOST_GLOBAL)
        drainMicrotasks()
        started = true
    }

    override fun evaluate(source: String): RuntimeEvaluation {
        threadGuard.checkAccess()
        val envelopeJson = runtime.getExecutor(evaluationEnvelopeScript(source)).executeString()
        drainMicrotasks()
        return parseEvaluationEnvelope(envelopeJson)
    }

    override fun terminateExecution() {
        runtime.terminateExecution()
    }

    override fun close() {
        threadGuard.checkAccess()
        runCatching { turnDriver?.close() }
        turnDriver = null
        runCatching { hostObject.unbind(callbacks) }
        runCatching { hostObject.close() }
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
                    val module = try {
                        assetResolver.resolve(resourceName, referrerUrl)
                    } catch (error: RuntimeEngineException) {
                        moduleResolutionFailure = error
                        return null
                    } catch (_: Throwable) {
                        moduleResolutionFailure = RuntimeEngineException(
                            RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                            "The runtime module resolver failed",
                        )
                        return null
                    }

                    moduleCache[module.resourceUrl]?.let { return it }

                    return try {
                        v8Runtime.getExecutor(module.source)
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

    private fun executeModule(resourceUrl: String, source: String) {
        moduleResolutionFailure = null
        try {
            runtime.getExecutor(source)
                .setModule(true)
                .setResourceName(resourceUrl)
                .executeVoid()
            moduleResolutionFailure?.let { throw it }
        } catch (error: Throwable) {
            throw moduleResolutionFailure ?: error
        } finally {
            moduleResolutionFailure = null
        }
    }

    private fun runHostTurn() {
        threadGuard.checkAccess()
        val driver = turnDriver ?: throw RuntimeEngineException(
            RuntimeEngineErrorCode.INTERNAL,
            "The runtime turn driver is unavailable",
        )
        driver.callVoid(runtime.globalObject, *emptyArray<Any>())
        drainMicrotasks()
    }

    private fun drainMicrotasks() {
        if (!checkpointRequested) return
        checkpointRequested = false
        runtime.await(V8AwaitMode.RunTillNoMoreTasks)
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

    private inner class HostCallbacks {
        @V8Function
        fun architecture(): String = runtimeArchitecture

        @V8Function
        fun dispatch(requestJson: String, contextJson: String): String {
            threadGuard.checkAccess()
            if (
                requestJson.toByteArray(Charsets.UTF_8).size > MAX_ROUND_TRIP_BYTES ||
                contextJson.toByteArray(Charsets.UTF_8).size > MAX_ROUND_TRIP_BYTES
            ) return INTERNAL_TERMINAL
            return runCatching { nativeHost.dispatch(requestJson, contextJson) }
                .mapCatching { response ->
                    if (response.toByteArray(Charsets.UTF_8).size > MAX_ROUND_TRIP_BYTES) {
                        error("response too large")
                    }
                    JSONObject(response)
                    response
                }
                .getOrDefault(INTERNAL_TERMINAL)
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
        private const val HOST_GLOBAL = "__oneworksAndroidHost"
        private const val INTERNAL_TERMINAL =
            "{\"type\":\"error\",\"error\":{\"domain\":\"runtime\",\"code\":\"internal\"}}"
        private const val MAX_ROUND_TRIP_BYTES = 64 * 1024
        private const val MAX_TERMINATION_REASON_BYTES = 4 * 1024
        private const val TURN_DRIVER_GLOBAL = "__oneworksAndroidTurn"
    }
}
