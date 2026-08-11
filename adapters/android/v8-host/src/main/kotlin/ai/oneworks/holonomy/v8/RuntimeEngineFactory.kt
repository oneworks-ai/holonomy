package ai.oneworks.holonomy.v8

import android.content.res.AssetManager
import android.os.Build
import ai.oneworks.holonomy.host.DedicatedThreadRuntimeEngine
import ai.oneworks.holonomy.host.RuntimeCapabilities
import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.host.RuntimeImplementationStage
import ai.oneworks.holonomy.host.RuntimeMicrotaskMode
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.host.SilentRuntimeProcessHost
import java.lang.ref.WeakReference

object RuntimeEngineFactory {
    /** A native-host instance is owned by the first runtime generation only. */
    @Deprecated(
        message = "Use nativeHostFactory when the runtime must support terminate and restart",
        level = DeprecationLevel.WARNING,
    )
    fun create(
        assets: AssetManager,
        nativeHost: RuntimeNativeHost,
        bootstrapAssetPath: String = "runtime/bootstrap.mjs",
        inspectorOptions: AdbInspectorOptions? = null,
        moduleResolver: RuntimeModuleResolver? = null,
        processHost: RuntimeProcessHost = SilentRuntimeProcessHost,
    ): RuntimeEngine = OneGenerationRuntimeEngine(
        createEngine(
            assets = assets,
            nativeHostSource = RuntimeNativeHostGenerationSource.oneGeneration(nativeHost),
            bootstrapAssetPath = bootstrapAssetPath,
            inspectorOptions = inspectorOptions,
            moduleResolver = moduleResolver,
            processHost = processHost,
        ),
    )

    /** Creates a restart-capable engine; the factory must return a never-issued host for every generation. */
    fun create(
        assets: AssetManager,
        nativeHostFactory: () -> RuntimeNativeHost,
        bootstrapAssetPath: String = "runtime/bootstrap.mjs",
        inspectorOptions: AdbInspectorOptions? = null,
        moduleResolver: RuntimeModuleResolver? = null,
        processHost: RuntimeProcessHost = SilentRuntimeProcessHost,
    ): RuntimeEngine = createEngine(
        assets = assets,
        nativeHostSource = RuntimeNativeHostGenerationSource.restartable(nativeHostFactory),
        bootstrapAssetPath = bootstrapAssetPath,
        inspectorOptions = inspectorOptions,
        moduleResolver = moduleResolver,
        processHost = processHost,
    )

    private fun createEngine(
        assets: AssetManager,
        nativeHostSource: RuntimeNativeHostGenerationSource,
        bootstrapAssetPath: String,
        inspectorOptions: AdbInspectorOptions?,
        moduleResolver: RuntimeModuleResolver?,
        processHost: RuntimeProcessHost,
    ): RuntimeEngine = DedicatedThreadRuntimeEngine(
        JavetRuntimeAdapterFactory(
            assets = assets,
            nativeHostSource = nativeHostSource,
            bootstrapAssetPath = bootstrapAssetPath,
            inspectorOptions = inspectorOptions,
            moduleResolver = moduleResolver,
            processHost = processHost,
            runtimeArchitecture = resolveRuntimeArchitecture(Build.SUPPORTED_ABIS),
        ),
    )
}

internal class OneGenerationRuntimeEngine(
    private val delegate: RuntimeEngine,
) : RuntimeEngine by delegate {
    override fun terminate() = delegate.dispose()
}

internal class JavetRuntimeAdapterFactory(
    private val assets: AssetManager,
    private val nativeHostSource: RuntimeNativeHostGenerationSource,
    private val bootstrapAssetPath: String,
    private val inspectorOptions: AdbInspectorOptions?,
    private val moduleResolver: RuntimeModuleResolver?,
    private val processHost: RuntimeProcessHost,
    private val runtimeArchitecture: String,
) : ai.oneworks.holonomy.host.RuntimeAdapterFactory {
    override val capabilities = RuntimeCapabilities(
        implementationStage = RuntimeImplementationStage.BOOTSTRAP,
        microtaskMode = RuntimeMicrotaskMode.AUTO,
        esmModules = true,
        inspectorEnabled = inspectorOptions != null,
    )

    override fun create(
        threadGuard: ai.oneworks.holonomy.host.RuntimeThreadGuard,
        host: ai.oneworks.holonomy.host.RuntimeAdapterHost,
    ): ai.oneworks.holonomy.host.RuntimeAdapter = JavetRuntimeAdapter(
        assets = assets,
        bootstrapAssetPath = bootstrapAssetPath,
        host = host,
        inspectorOptions = inspectorOptions,
        moduleResolver = moduleResolver,
        processHost = processHost,
        nativeHost = nativeHostSource.create(),
        runtimeArchitecture = runtimeArchitecture,
        threadGuard = threadGuard,
    )
}

internal class RuntimeNativeHostGenerationSource private constructor(
    private val factory: () -> RuntimeNativeHost,
    private val restartable: Boolean,
) {
    private val issuedHosts = mutableListOf<WeakReference<RuntimeNativeHost>>()
    private var generationClaimed = false

    @Synchronized
    fun create(): RuntimeNativeHost {
        check(restartable || !generationClaimed) {
            "A RuntimeNativeHost instance cannot be reused by a restarted runtime"
        }
        val nativeHost = factory()
        issuedHosts.removeAll { reference -> reference.get() == null }
        check(issuedHosts.none { reference -> reference.get() === nativeHost }) {
            "RuntimeNativeHost factory must return a fresh instance for each generation"
        }
        generationClaimed = true
        issuedHosts += WeakReference(nativeHost)
        return nativeHost
    }

    companion object {
        fun oneGeneration(nativeHost: RuntimeNativeHost) = RuntimeNativeHostGenerationSource(
            factory = { nativeHost },
            restartable = false,
        )

        fun restartable(factory: () -> RuntimeNativeHost) = RuntimeNativeHostGenerationSource(
            factory = factory,
            restartable = true,
        )
    }
}

internal fun resolveRuntimeArchitecture(supportedAbis: Array<String>): String = when (supportedAbis.firstOrNull()) {
    "arm64-v8a" -> "arm64"
    "x86_64" -> "x64"
    else -> throw IllegalArgumentException("The Android runtime ABI is unsupported")
}
