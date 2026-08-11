package ai.oneworks.holonomy.session

import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeProcessHost
import java.net.URI

/**
 * Android application integration seam. A V8-backed application adapts this to
 * RuntimeEngineFactory without making the session core depend on AssetManager or Javet.
 */
fun interface SessionRuntimeFactory {
    fun create(context: SessionRuntimeContext): SessionRuntimeInstance
}

data class SessionRuntimeInstance(
    val engine: RuntimeEngine,
    val control: SessionRuntimeControl,
)

/**
 * Implementations must serialize this trusted control onto the owned runtime thread. The factory
 * can inspect context.spec.initialControls while constructing its bootstrap; the supervisor also
 * applies them through this seam after engine start and before executing the user entry module.
 */
fun interface SessionRuntimeControl {
    fun apply(control: SessionControlOperation): java.util.concurrent.CompletableFuture<Unit>
}

data class SessionRuntimeContext(
    val runtimeId: RuntimeId,
    val generation: Long,
    val spec: SessionRuntimeSpec,
    val processHost: RuntimeProcessHost,
    val moduleResolver: RuntimeModuleResolver,
    val sandboxPolicyDigest: String,
    val principal: String,
    val freshNativeHostFactory: () -> RuntimeNativeHost,
)

data class SessionNativeHostContext(
    val runtimeId: RuntimeId,
    val runtimeGeneration: Long,
    val nativeHostGeneration: Long,
    val sandboxPolicy: SessionSandboxPolicy,
    val sandboxPolicyDigest: String,
    val principal: String,
) {
    init {
        require(runtimeGeneration > 0 && nativeHostGeneration > 0)
        require(sandboxPolicyDigest == sandboxPolicy.digest)
        require(PRINCIPAL.matches(principal))
    }

    private companion object {
        private val PRINCIPAL = Regex("[A-Za-z0-9:._-]{1,128}")
    }
}

/** Every invocation must return a never-issued NativeHost identity. */
fun interface SessionNativeHostFactory {
    fun create(context: SessionNativeHostContext): RuntimeNativeHost
}

internal class SessionModuleGraph(spec: SessionRuntimeSpec) {
    private val modules = spec.modules.associate { module ->
        module.url to RuntimeModuleSource(module.url, module.source)
    }

    val entry: RuntimeModuleSource = modules.getValue(spec.entryUrl)

    val resolver = RuntimeModuleResolver { specifier, referrerUrl ->
        val canonical = runCatching {
            val candidate = URI(specifier)
            if (candidate.isAbsolute) candidate else URI(requireNotNull(referrerUrl)).resolve(candidate)
        }.getOrNull()?.normalize()?.toString()
        canonical?.let(modules::get)
    }
}
