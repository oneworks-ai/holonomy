package ai.oneworks.holonomy.host

import java.net.URI
import java.util.concurrent.CompletableFuture

interface RuntimeEngine {
    val capabilities: RuntimeCapabilities

    fun start(): CompletableFuture<Unit>

    fun evaluate(source: String): CompletableFuture<RuntimeEvaluation>

    fun terminate(): CompletableFuture<Unit>

    fun dispose(): CompletableFuture<Unit>
}

data class RuntimeCapabilities(
    val implementationStage: RuntimeImplementationStage,
    val microtaskMode: RuntimeMicrotaskMode,
    val esmModules: Boolean,
    val inspectorEnabled: Boolean,
)

enum class RuntimeImplementationStage {
    BOOTSTRAP,
}

enum class RuntimeMicrotaskMode {
    AUTO,
}

data class RuntimeModuleSource(
    val resourceUrl: String,
    val source: String,
)

data class RuntimeEvaluation(
    val kind: Kind,
    val value: String? = null,
) {
    enum class Kind {
        UNDEFINED,
        NULL,
        BOOLEAN,
        NUMBER,
        STRING,
        BIGINT,
        JSON,
        OPAQUE,
    }
}

enum class RuntimeEngineErrorCode(
    val stableCode: String,
) {
    INVALID_ARGUMENT("runtime.invalid_argument"),
    NOT_SUPPORTED("runtime.not_supported"),
    TERMINATED("runtime.terminated"),
    DISPOSED("runtime.disposed"),
    MODULE_NOT_FOUND("runtime.module_not_found"),
    MODULE_RESOLUTION_FAILED("runtime.module_resolution_failed"),
    INTERNAL("runtime.internal"),
}

class RuntimeEngineException(
    val code: RuntimeEngineErrorCode,
    message: String,
) : IllegalStateException(message)

fun interface RuntimeNativeHost {
    /**
     * Receives the validated guest request separately from provider-only context.
     * Implementations must re-authorize the context and return one terminal JSON envelope.
     */
    fun dispatch(requestJson: String, contextJson: String): String
}

class FailClosedRuntimeNativeHost : RuntimeNativeHost {
    @Volatile
    var dispatchCount: Int = 0
        private set

    @Volatile
    var lastRequestJson: String? = null
        private set

    @Volatile
    var lastContextJson: String? = null
        private set

    override fun dispatch(requestJson: String, contextJson: String): String {
        dispatchCount += 1
        lastRequestJson = requestJson
        lastContextJson = contextJson
        return FAIL_CLOSED_TERMINAL
    }

    private companion object {
        private const val FAIL_CLOSED_TERMINAL =
            "{\"type\":\"error\",\"error\":{\"domain\":\"runtime\",\"code\":\"capability_unsupported\"}}"
    }
}

interface RuntimeAdapterFactory {
    val capabilities: RuntimeCapabilities

    fun create(
        threadGuard: RuntimeThreadGuard,
        host: RuntimeAdapterHost,
    ): RuntimeAdapter
}

interface RuntimeAdapterHost {
    /**
     * Arms or cancels the adapter's single host wakeup. The callback is admitted only for the
     * adapter generation that requested it and always runs on the dedicated runtime thread.
     */
    fun requestWakeup(
        deadlineMs: Long?,
        observedNowMs: Long,
        callback: () -> Unit,
    )

    /** Queues termination after the current runtime callback unwinds. */
    fun requestTermination()
}

interface RuntimeAdapter : AutoCloseable {
    fun start()

    fun evaluate(source: String): RuntimeEvaluation

    /** This is the only adapter operation that may be called off the runtime thread. */
    fun terminateExecution()

    override fun close()
}

class RuntimeThreadGuard(
    private val threadName: String,
) {
    @Volatile
    private var ownerThread: Thread? = null

    fun bindToCurrentThread() {
        val currentThread = Thread.currentThread()
        val existingOwner = ownerThread
        check(existingOwner == null || existingOwner === currentThread) {
            "$threadName is already bound to another thread"
        }
        ownerThread = currentThread
    }

    fun checkAccess() {
        check(Thread.currentThread() === ownerThread) {
            "$threadName may only be accessed from its dedicated runtime thread"
        }
    }
}

internal fun validateModuleSource(module: RuntimeModuleSource): RuntimeEngineException? {
    if (module.source.isBlank()) {
        return RuntimeEngineException(
            RuntimeEngineErrorCode.INVALID_ARGUMENT,
            "Module source must not be blank",
        )
    }
    val resourceUri = runCatching { URI(module.resourceUrl) }.getOrNull()
    if (resourceUri?.isAbsolute != true || resourceUri.scheme.isNullOrBlank()) {
        return RuntimeEngineException(
            RuntimeEngineErrorCode.INVALID_ARGUMENT,
            "Module resourceUrl must be an absolute URL",
        )
    }
    return null
}
