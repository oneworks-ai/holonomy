package ai.oneworks.holonomy.e2e

import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import ai.oneworks.holonomy.network.AndroidHttpNetworkHost
import ai.oneworks.holonomy.network.AndroidNetworkHostConfiguration
import ai.oneworks.holonomy.network.AndroidNetworkLimits
import ai.oneworks.holonomy.network.PrivateNetworkPolicy
import ai.oneworks.holonomy.session.SessionNativeHostContext
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.session.SessionSandboxNetworkLimits
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/** Policy-bound wiring used by the non-UI session Supervisor. */
internal fun createE2eRuntimeNativeHost(context: SessionNativeHostContext): RuntimeNativeHost =
    when (context.sandboxPolicy.network.access) {
        SessionSandboxNetworkAccess.NONE -> FailClosedRuntimeNativeHost()
        SessionSandboxNetworkAccess.MOCK_ONLY -> MockOnlyRuntimeNativeHost(context)
        SessionSandboxNetworkAccess.RESTRICTED -> AndroidHttpNetworkHost(
            AndroidNetworkHostConfiguration(
                principal = context.principal,
                allowedOrigins = context.sandboxPolicy.network.allowedOrigins,
                allowedSchemes = context.sandboxPolicy.network.allowedSchemes,
                privateNetwork = if (context.sandboxPolicy.network.allowPrivateNetwork) {
                    PrivateNetworkPolicy.ALLOW
                } else {
                    PrivateNetworkPolicy.DENY
                },
                limits = context.sandboxPolicy.network.limits.toAndroidLimits(),
            ),
        )
    }

/** The legacy non-session debug Activity is deliberately fail-closed. */
internal fun createE2eRuntimeNativeHost(): RuntimeNativeHost = FailClosedRuntimeNativeHost()

private class MockOnlyRuntimeNativeHost(
    context: SessionNativeHostContext,
) : RuntimeNativeHost {
    private val failClosed = FailClosedRuntimeNativeHost()
    private val configuration = JSONObject()
        .put("capabilities", JSONArray().put("host.network.mock"))
        .put("principal", context.principal)
        .put(
            "network",
            JSONObject()
                .put("allowedOrigins", JSONArray(context.sandboxPolicy.network.allowedOrigins.sorted()))
                .put("allowedSchemes", JSONArray(context.sandboxPolicy.network.allowedSchemes.sorted()))
                .put(
                    "limits",
                    JSONObject().apply {
                        val limits = context.sandboxPolicy.network.limits
                        put("maxChunkBytes", limits.maxChunkBytes)
                        put("maxConcurrentConnections", limits.maxConcurrentConnections)
                        put("maxHeaderBytes", limits.maxHeaderBytes)
                        put("maxHeaders", limits.maxHeaders)
                        put("maxRedirects", 10)
                        put("maxRequestBodyBytes", limits.maxRequestBodyBytes)
                        put("maxResponseBodyBytes", limits.maxResponseBodyBytes)
                        put("maxWebSocketBufferedBytes", 1024 * 1024)
                        put("maxWebSocketMessageBytes", 1024 * 1024)
                    },
                )
                .put(
                    "privateNetwork",
                    if (context.sandboxPolicy.network.allowPrivateNetwork) "allow" else "deny",
                ),
        )
        .toString()

    override fun configurationJson(): String = configuration

    override fun dispatch(
        requestId: String,
        requestJson: String,
        contextJson: String,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
        resourceSink: RuntimeNativeResourceEventSink,
    ) {
        E2eNativeHostDiagnostics.recordMockOnlyDispatch()
        failClosed.dispatch(requestId, requestJson, contextJson, binary, sink, resourceSink)
    }

    override fun close() = failClosed.close()
}

internal object E2eNativeHostDiagnostics {
    private val mockOnlyDispatches = AtomicInteger()

    fun resetMockOnlyDispatches() {
        mockOnlyDispatches.set(0)
    }

    fun mockOnlyDispatchCount(): Int = mockOnlyDispatches.get()

    internal fun recordMockOnlyDispatch() {
        mockOnlyDispatches.incrementAndGet()
    }
}

private fun SessionSandboxNetworkLimits.toAndroidLimits() = AndroidNetworkLimits(
    maxAllowedOrigins = 64,
    maxChunkBytes = maxChunkBytes,
    maxConcurrentConnections = maxConcurrentConnections,
    maxHeaderBytes = maxHeaderBytes,
    maxHeaders = maxHeaders,
    maxRequestBodyBytes = maxRequestBodyBytes,
    maxResponseBodyBytes = maxResponseBodyBytes,
    maxUrlBytes = maxUrlBytes,
    socketTimeoutMs = socketTimeoutMs,
)
