package ai.oneworks.mobile.runtime.v8

import android.content.res.AssetManager
import android.os.Build
import ai.oneworks.mobile.runtime.host.DedicatedThreadRuntimeEngine
import ai.oneworks.mobile.runtime.host.RuntimeCapabilities
import ai.oneworks.mobile.runtime.host.RuntimeEngine
import ai.oneworks.mobile.runtime.host.RuntimeImplementationStage
import ai.oneworks.mobile.runtime.host.RuntimeMicrotaskMode
import ai.oneworks.mobile.runtime.host.RuntimeNativeHost

object RuntimeEngineFactory {
    fun create(
        assets: AssetManager,
        nativeHost: RuntimeNativeHost,
        bootstrapAssetPath: String = "runtime/bootstrap.mjs",
    ): RuntimeEngine = DedicatedThreadRuntimeEngine(
        JavetRuntimeAdapterFactory(
            assets = assets,
            nativeHost = nativeHost,
            bootstrapAssetPath = bootstrapAssetPath,
            runtimeArchitecture = resolveRuntimeArchitecture(Build.SUPPORTED_ABIS),
        ),
    )
}

internal class JavetRuntimeAdapterFactory(
    private val assets: AssetManager,
    private val nativeHost: RuntimeNativeHost,
    private val bootstrapAssetPath: String,
    private val runtimeArchitecture: String,
) : ai.oneworks.mobile.runtime.host.RuntimeAdapterFactory {
    override val capabilities = RuntimeCapabilities(
        implementationStage = RuntimeImplementationStage.BOOTSTRAP,
        microtaskMode = RuntimeMicrotaskMode.AUTO,
        esmModules = true,
        inspectorEnabled = false,
    )

    override fun create(
        threadGuard: ai.oneworks.mobile.runtime.host.RuntimeThreadGuard,
        host: ai.oneworks.mobile.runtime.host.RuntimeAdapterHost,
    ): ai.oneworks.mobile.runtime.host.RuntimeAdapter = JavetRuntimeAdapter(
        assets = assets,
        bootstrapAssetPath = bootstrapAssetPath,
        host = host,
        nativeHost = nativeHost,
        runtimeArchitecture = runtimeArchitecture,
        threadGuard = threadGuard,
    )
}

internal fun resolveRuntimeArchitecture(supportedAbis: Array<String>): String = when (supportedAbis.firstOrNull()) {
    "arm64-v8a" -> "arm64"
    "x86_64" -> "x64"
    else -> throw IllegalArgumentException("The Android runtime ABI is unsupported")
}
