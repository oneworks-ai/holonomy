package ai.oneworks.holonomy.e2e

import android.app.Application
import ai.oneworks.holonomy.session.HolonomySessionServiceDependencies
import ai.oneworks.holonomy.session.HolonomySessionServiceProvider
import ai.oneworks.holonomy.session.SessionNativeHostFactory
import ai.oneworks.holonomy.session.SessionRuntimeFactory
import ai.oneworks.holonomy.session.SessionRuntimeInstance
import ai.oneworks.holonomy.v8.AdbInspectorOptions
import ai.oneworks.holonomy.v8.RuntimeEngineFactory

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
            )
            SessionRuntimeInstance(
                engine = engine,
                control = { operation -> engine.control(operation.operation, operation.valueJson) },
            )
        },
        nativeHostFactory = SessionNativeHostFactory(::createE2eRuntimeNativeHost),
    )
}
