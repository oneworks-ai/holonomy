package ai.oneworks.holonomy.e2e

import android.app.Application
import ai.oneworks.holonomy.session.HolonomySessionServiceDependencies
import ai.oneworks.holonomy.session.HolonomySessionServiceProvider
import ai.oneworks.holonomy.session.SessionNativeHostFactory
import ai.oneworks.holonomy.session.SessionRuntimeFactory
import ai.oneworks.holonomy.session.SessionRuntimeInstance
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.v8.AdbInspectorOptions
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import ai.oneworks.holonomy.v86.AndroidV86HostNetworkTransport
import ai.oneworks.holonomy.v86.AndroidV86NetworkAddressResolver
import ai.oneworks.holonomy.v86.AndroidV86NetworkTransport
import ai.oneworks.holonomy.v86.AndroidV86RuntimeServicesFactory
import java.net.InetAddress
import org.json.JSONObject

class HolonomyE2eApplication : Application(), HolonomySessionServiceProvider {
    override fun createHolonomySessionServiceDependencies() = HolonomySessionServiceDependencies(
        runtimeFactory = SessionRuntimeFactory { context ->
            val inspector = context.spec.inspector?.let { spec ->
                AdbInspectorOptions(
                    socketName = spec.socketName,
                    waitForDebugger = spec.breakBeforeEntry,
                )
            }
            val engine = RuntimeEngineFactory.create(
                assets = assets,
                inspectorOptions = inspector,
                moduleResolver = context.moduleResolver,
                nativeHostFactory = context.freshNativeHostFactory,
                processHost = context.processHost,
                capabilityServicesFactory = context.capabilityRuntimeConfigurationJson?.let { configuration ->
                    AndroidV86RuntimeServicesFactory(
                        applicationContext = this,
                        configurationJson = configuration,
                        processId = context.runtimeId.value,
                        generation = context.generation,
                        principal = context.principal,
                        expectedNetworkProvider = if (
                            context.spec.sandboxPolicy.network.access == SessionSandboxNetworkAccess.MOCK_ONLY
                        ) "host.network.mock" else "host.network",
                        capabilityDomains = setOf("device", "system"),
                        backendDiagnostics = true,
                        networkTransport = v86NetworkTransport(configuration),
                    )
                },
            )
            SessionRuntimeInstance(
                engine = engine,
                control = { operation -> engine.control(operation.operation, operation.valueJson) },
            )
        },
        nativeHostFactory = SessionNativeHostFactory(::createE2eRuntimeNativeHost),
    )

    private fun v86NetworkTransport(configuration: String): AndroidV86NetworkTransport? {
        val process = JSONObject(configuration).getJSONObject("session")
            .getJSONObject("runtimeCreation").getJSONObject("configuration")
            .getJSONObject("sandboxPolicy").getJSONObject("process")
        if (process.getString("access") != "sandboxed" ||
            process.getJSONObject("network").getString("access") != "restricted"
        ) return null
        return AndroidV86HostNetworkTransport(
            addressResolver = AndroidV86NetworkAddressResolver { hostname ->
                if (hostname == V86_TEST_HOSTNAME) {
                    listOf(InetAddress.getByName("127.0.0.1"))
                } else {
                    InetAddress.getAllByName(hostname).toList()
                }
            },
        )
    }

    private companion object {
        private const val V86_TEST_HOSTNAME = "android-v86.test"
    }
}
