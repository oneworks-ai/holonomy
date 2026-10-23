package ai.oneworks.holonomy.v8

import android.content.res.AssetManager
import android.os.Build
import ai.oneworks.holonomy.host.DedicatedThreadRuntimeEngine
import ai.oneworks.holonomy.host.RuntimeCapabilities
import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityServicesFactory
import ai.oneworks.holonomy.host.RuntimeCryptoHost
import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.host.RuntimeEngineGate
import ai.oneworks.holonomy.host.RuntimeImplementationStage
import ai.oneworks.holonomy.host.RuntimeMicrotaskMode
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeProcessHost
import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.SilentRuntimeProcessHost

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
        capabilityHost: RuntimeCapabilityHost? = null,
        trustedBackend: RuntimeTrustedBackend? = null,
        engineGate: RuntimeEngineGate? = null,
    ): RuntimeEngine = OneGenerationRuntimeEngine(
        createEngine(
            assets = assets,
            nativeHostSource = RuntimeNativeHostGenerationSource.oneGeneration(nativeHost),
            bootstrapAssetPath = bootstrapAssetPath,
            inspectorOptions = inspectorOptions,
            moduleResolver = moduleResolver,
            processHost = processHost,
            capabilityHostSource = capabilityHost?.let(RuntimeCapabilityHostGenerationSource::oneGeneration),
            trustedBackendSource = trustedBackend?.let(RuntimeTrustedBackendGenerationSource::oneGeneration),
            engineGateSource = engineGate?.let(RuntimeEngineGateGenerationSource::oneGeneration),
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
        capabilityHostFactory: (() -> RuntimeCapabilityHost)? = null,
        trustedBackendFactory: (() -> RuntimeTrustedBackend)? = null,
        capabilityServicesFactory: RuntimeCapabilityServicesFactory? = null,
        engineGateFactory: (() -> RuntimeEngineGate)? = null,
        cryptoHostFactory: (() -> RuntimeCryptoHost)? = null,
    ): RuntimeEngine {
        require(
            capabilityServicesFactory == null || capabilityHostFactory == null && trustedBackendFactory == null,
        ) { "Capability services cannot be combined with individual factories" }
        return createEngine(
        assets = assets,
        nativeHostSource = RuntimeNativeHostGenerationSource.restartable(nativeHostFactory),
        bootstrapAssetPath = bootstrapAssetPath,
        inspectorOptions = inspectorOptions,
        moduleResolver = moduleResolver,
        processHost = processHost,
        capabilityHostSource = capabilityHostFactory?.let(RuntimeCapabilityHostGenerationSource::restartable),
        trustedBackendSource = trustedBackendFactory?.let(RuntimeTrustedBackendGenerationSource::restartable),
        capabilityServicesSource = capabilityServicesFactory?.let { factory ->
            RuntimeCapabilityServicesGenerationSource(factory::create)
        },
        engineGateSource = engineGateFactory?.let(RuntimeEngineGateGenerationSource::restartable),
        cryptoHostSource = cryptoHostFactory?.let(::RuntimeCryptoHostGenerationSource),
        )
    }

    private fun createEngine(
        assets: AssetManager,
        nativeHostSource: RuntimeNativeHostGenerationSource,
        bootstrapAssetPath: String,
        inspectorOptions: AdbInspectorOptions?,
        moduleResolver: RuntimeModuleResolver?,
        processHost: RuntimeProcessHost,
        capabilityHostSource: RuntimeCapabilityHostGenerationSource?,
        trustedBackendSource: RuntimeTrustedBackendGenerationSource?,
        capabilityServicesSource: RuntimeCapabilityServicesGenerationSource? = null,
        engineGateSource: RuntimeEngineGateGenerationSource? = null,
        cryptoHostSource: RuntimeCryptoHostGenerationSource? = null,
    ): RuntimeEngine = DedicatedThreadRuntimeEngine(
        JavetRuntimeAdapterFactory(
            assets = assets,
            nativeHostSource = nativeHostSource,
            bootstrapAssetPath = bootstrapAssetPath,
            inspectorOptions = inspectorOptions,
            moduleResolver = moduleResolver,
            processHost = processHost,
            capabilityHostSource = capabilityHostSource,
            trustedBackendSource = trustedBackendSource,
            capabilityServicesSource = capabilityServicesSource,
            engineGateSource = engineGateSource,
            runtimeArchitecture = resolveRuntimeArchitecture(Build.SUPPORTED_ABIS),
            cryptoHostSource = cryptoHostSource,
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
    private val capabilityHostSource: RuntimeCapabilityHostGenerationSource?,
    private val trustedBackendSource: RuntimeTrustedBackendGenerationSource?,
    private val capabilityServicesSource: RuntimeCapabilityServicesGenerationSource?,
    private val engineGateSource: RuntimeEngineGateGenerationSource?,
    private val runtimeArchitecture: String,
    private val cryptoHostSource: RuntimeCryptoHostGenerationSource? = null,
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
    ): ai.oneworks.holonomy.host.RuntimeAdapter {
        val services = capabilityServicesSource?.create()
        val construct = { crypto: RuntimeCryptoHost? -> JavetRuntimeAdapter(
        assets = assets,
        bootstrapAssetPath = bootstrapAssetPath,
        host = host,
        inspectorOptions = inspectorOptions,
        moduleResolver = moduleResolver,
        processHost = processHost,
        capabilityHost = services?.capabilityHost ?: capabilityHostSource?.create(),
        trustedBackend = services?.trustedBackend ?: trustedBackendSource?.create(),
        engineGate = engineGateSource?.create(),
        cryptoHost = crypto,
        nativeHost = services?.nativeHost ?: nativeHostSource.create(),
        runtimeArchitecture = runtimeArchitecture,
        threadGuard = threadGuard,
        ) }
        return cryptoHostSource?.createOwned(construct) ?: construct(null)
    }
}

internal fun resolveRuntimeArchitecture(supportedAbis: Array<String>): String = when (supportedAbis.firstOrNull()) {
    "arm64-v8a" -> "arm64"
    "x86_64" -> "x64"
    else -> throw IllegalArgumentException("The Android runtime ABI is unsupported")
}
