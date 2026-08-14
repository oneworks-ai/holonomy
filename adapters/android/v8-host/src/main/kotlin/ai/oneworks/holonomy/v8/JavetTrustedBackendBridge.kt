package ai.oneworks.holonomy.v8

import ai.oneworks.holonomy.host.RuntimeAdapterHost
import ai.oneworks.holonomy.host.RuntimeTrustedBackendChannel
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import ai.oneworks.holonomy.host.RuntimeTrustedBackendTerminalSink
import com.caoccao.javet.interop.V8Runtime
import com.caoccao.javet.values.V8Value
import com.caoccao.javet.values.primitive.V8ValueString
import com.caoccao.javet.values.reference.IV8ValuePromise
import com.caoccao.javet.values.reference.V8ValueFunction
import com.caoccao.javet.values.reference.V8ValuePromise
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

/** Generation fence between Host-owned Backend workers and the admitted JS Runtime Kernel. */
internal class JavetTrustedBackendBridge(
    private val runtime: V8Runtime,
    private val driver: V8ValueFunction,
    private val runtimeHost: RuntimeAdapterHost,
    private val driveRuntime: () -> Unit,
) : RuntimeTrustedBackendHost, AutoCloseable {
    private val closed = AtomicBoolean(false)
    private val invocations = ConcurrentHashMap<Long, Invocation>()
    private val nextInvocationId = AtomicLong(1)

    override fun invoke(
        channel: RuntimeTrustedBackendChannel,
        requestJson: String,
        sink: RuntimeTrustedBackendTerminalSink,
    ) {
        val terminal = runCatching { validateRequest(requestJson); null }.getOrElse { invalidTerminal() }
        if (terminal != null || closed.get()) {
            runCatching { sink.emit(terminal ?: staleTerminal()) }
            return
        }
        val id = nextInvocationId.getAndIncrement()
        val invocation = Invocation(sink)
        invocations[id] = invocation
        runtimeHost.requestRuntimeTask {
            if (closed.get() || invocations[id] !== invocation) return@requestRuntimeTask
            dispatch(id, invocation, channel, requestJson)
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val terminal = staleTerminal()
        invocations.entries.sortedBy { it.key }.forEach { (id, invocation) ->
            if (invocations.remove(id, invocation)) {
                runCatching { invocation.promise?.close() }
                runCatching { invocation.sink.emit(terminal) }
            }
        }
        runCatching { driver.close() }
    }

    private fun dispatch(
        id: Long,
        invocation: Invocation,
        channel: RuntimeTrustedBackendChannel,
        requestJson: String,
    ) {
        val result = runCatching {
            driver.call<V8Value>(runtime.globalObject, channel.wireName, requestJson)
        }.getOrElse {
            complete(id, invocation, internalTerminal())
            return
        }
        if (result !is V8ValuePromise) {
            try {
                complete(id, invocation, terminal(result))
            } finally {
                runCatching { result.close() }
            }
            return
        }
        invocation.promise = result
        result.register(
            object : IV8ValuePromise.IListener {
                override fun onCatch(value: V8Value) = reject(id, invocation)

                override fun onFulfilled(value: V8Value) = complete(id, invocation, terminal(value))

                override fun onRejected(value: V8Value) = reject(id, invocation)
            },
        )
        result.markAsHandled()
        repeat(MAX_IMMEDIATE_CHECKPOINTS) {
            if (invocations[id] !== invocation) return@repeat
            driveRuntime()
        }
        if (invocations[id] === invocation) {
            runtimeHost.requestRuntimeTask {
                if (closed.get() || invocations[id] !== invocation) return@requestRuntimeTask
                driveRuntime()
            }
        }
    }

    private fun reject(id: Long, invocation: Invocation) =
        complete(id, invocation, internalTerminal())

    private fun complete(id: Long, invocation: Invocation, terminal: String) {
        if (!invocations.remove(id, invocation)) return
        runCatching { invocation.promise?.close() }
        invocation.promise = null
        runCatching { invocation.sink.emit(terminal) }
    }

    private fun terminal(value: V8Value): String =
        (value as? V8ValueString)?.toPrimitive()
            ?.takeIf { source -> source.toByteArray(Charsets.UTF_8).size <= MAX_TERMINAL_BYTES }
            ?.takeIf { source -> runCatching { JSONObject(source) }.isSuccess }
            ?: internalTerminal()

    private fun validateRequest(source: String) {
        require(source.toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_BYTES)
        JSONObject(source)
    }

    private class Invocation(
        val sink: RuntimeTrustedBackendTerminalSink,
    ) {
        @Volatile
        var promise: V8ValuePromise? = null
    }

    private companion object {
        private const val MAX_REQUEST_BYTES = 512 * 1024
        private const val MAX_TERMINAL_BYTES = 1024 * 1024
        private const val MAX_IMMEDIATE_CHECKPOINTS = 16

        private fun invalidTerminal() = failure("runtime.configuration_invalid")
        private fun internalTerminal() = failure("runtime.internal")
        private fun staleTerminal() = failure("runtime.generation_stale")
        private fun failure(code: String) = JSONObject()
            .put("ok", false)
            .put("error", JSONObject().put("code", code))
            .toString()
    }
}
