package ai.oneworks.holonomy.e2e

import android.app.Application
import ai.oneworks.holonomy.capability.AndroidCapabilityHost
import ai.oneworks.holonomy.session.HolonomySessionServiceDependencies
import ai.oneworks.holonomy.session.HolonomySessionServiceProvider
import ai.oneworks.holonomy.session.SessionNativeHostFactory
import ai.oneworks.holonomy.session.SessionRuntimeFactory
import ai.oneworks.holonomy.session.SessionRuntimeInstance
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.v8.AdbInspectorOptions
import ai.oneworks.holonomy.v8.RuntimeEngineFactory
import com.caoccao.javet.interop.options.V8RuntimeOptions

class HolonomyE2eApplication : Application(), HolonomySessionServiceProvider {
    override fun onCreate() {
        V8RuntimeOptions.V8_FLAGS.setCustomFlags(V86_V8_FLAGS)
        super.onCreate()
    }

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
                capabilityHostFactory = context.capabilityRuntimeConfigurationJson?.let { configuration ->
                    {
                        AndroidCapabilityHost(
                            applicationContext = this,
                            configurationJson = configuration,
                            processId = context.runtimeId.value,
                            generation = context.generation,
                            expectedNetworkProvider = if (
                                context.spec.sandboxPolicy.network.access == SessionSandboxNetworkAccess.MOCK_ONLY
                            ) {
                                "host.network.mock"
                            } else {
                                "host.network"
                            },
                        )
                    }
                },
                trustedBackendFactory = context.capabilityRuntimeConfigurationJson?.let {
                    {
                        if (assets.list(V86_ROOT).orEmpty().contains("v86.wasm")) {
                            V86TrustedBackendProbe(assets, context.runtimeId.value, context.generation)
                        } else {
                            E2eTrustedBackend(context.runtimeId.value, context.generation)
                        }
                    }
                },
            )
            SessionRuntimeInstance(
                engine = engine,
                control = { operation -> engine.control(operation.operation, operation.valueJson) },
            )
        },
        nativeHostFactory = SessionNativeHostFactory(::createE2eRuntimeNativeHost),
    )

    private companion object {
        private const val V86_ROOT = "runtime/process-backends/v86"
        private const val V86_V8_FLAGS =
            "--liftoff-only --no-wasm-tier-up --no-wasm-dynamic-tiering --wasm-num-compilation-tasks=1"
    }
}
