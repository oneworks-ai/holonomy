package ai.oneworks.holonomy.host

import java.net.URI
import java.util.concurrent.CompletableFuture

interface RuntimeEngine {
    val capabilities: RuntimeCapabilities

    fun start(): CompletableFuture<Unit>

    fun evaluate(source: String): CompletableFuture<RuntimeEvaluation>

    /** Executes one trusted-host supplied ES module with its canonical external URL. */
    fun executeModule(module: RuntimeModuleSource): CompletableFuture<Unit>

    /** Applies a bounded trusted-host control command on the owned runtime thread. */
    fun control(operation: String, valueJson: String): CompletableFuture<Unit> = CompletableFuture.failedFuture(
        RuntimeEngineException(RuntimeEngineErrorCode.NOT_SUPPORTED, "Runtime control is unavailable"),
    )

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

data class RuntimeProcessConfiguration(
    val argv: List<String> = emptyList(),
    val cwd: String = "/runtime",
    val env: Map<String, String> = emptyMap(),
    val execPath: String = "/runtime/holonomy",
    val pid: Int = 1,
    val runtimePluginsJson: String = "[]",
)

interface RuntimeProcessHost {
    val configuration: RuntimeProcessConfiguration

    fun write(stream: RuntimeOutputStream, chunk: String)

    /** Optional lossy diagnostics side channel; it never participates in guest execution. */
    fun networkDiagnostic(eventJson: String) = Unit

    fun exit(code: Int)
}

enum class RuntimeOutputStream {
    STDERR,
    STDOUT,
}

object SilentRuntimeProcessHost : RuntimeProcessHost {
    override val configuration = RuntimeProcessConfiguration()

    override fun write(stream: RuntimeOutputStream, chunk: String) = Unit

    override fun exit(code: Int) = Unit
}

fun interface RuntimeModuleResolver {
    /**
     * Resolves a guest module without imposing a URL scheme. Returning null is the only
     * not-found signal; the returned resource URL must be absolute and becomes its V8 identity.
     */
    fun resolve(specifier: String, referrerUrl: String?): RuntimeModuleSource?
}

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

data class RuntimeNativeBinary(
    val handle: String,
    val data: ByteArray,
)

data class RuntimeNativeEvent(
    val eventJson: String,
    val binary: List<RuntimeNativeBinary> = emptyList(),
)

fun interface RuntimeNativeEventSink {
    fun emit(event: RuntimeNativeEvent)
}

fun interface RuntimeNativeResourceEventSink {
    fun emit(eventJson: String)
}

interface RuntimeNativeHost : AutoCloseable {
    /** Host-owned capability configuration consumed before the guest global is removed. */
    fun configurationJson(): String = "{\"capabilities\":[]}"

    /**
     * Receives validated request metadata separately from copied binary and provider-only context.
     * Implementations re-authorize immediately before work and emit only bounded stable events.
     */
    fun dispatch(
        requestId: String,
        requestJson: String,
        contextJson: String,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
        resourceSink: RuntimeNativeResourceEventSink,
    )

    fun cancel(callToken: String, reason: String?) = Unit

    fun closeResource(ownerCallToken: String, providerToken: String, reason: String?) = Unit

    fun grantCredits(callToken: String, credits: Int) = Unit

    override fun close() = Unit
}

/** Generation-owned authority for capability Runtime configuration and provider calls. */
interface RuntimeCapabilityHost : AutoCloseable {
    /** Finite JSON consumed by the reserved bootstrap before any Guest entry can execute. */
    fun configurationJson(): String

    /** Finite JSON terminal. Implementations re-authorize and never expose native platform values. */
    fun invokeSync(requestJson: String): String

    /** Subscribes a generation-bound resource. Events are finite JSON and may arrive off-thread. */
    fun subscribeResource(bindingId: String, sink: RuntimeCapabilityResourceEventSink): AutoCloseable? = null

    /** Releases one generation-bound resource. Unknown or already released bindings are ignored. */
    fun releaseResource(bindingId: String) = Unit

    override fun close() = Unit
}

fun interface RuntimeCapabilityResourceEventSink {
    fun emit(eventJson: String)
}

/** Channels exposed only to generation-owned trusted Backend implementations. */
enum class RuntimeTrustedBackendChannel(
    val wireName: String,
) {
    LINUX_FILESYSTEM("linuxFilesystem"),
    LINUX_PROCESS_NETWORK("linuxProcessNetwork"),
}

fun interface RuntimeTrustedBackendTerminalSink {
    fun emit(terminalJson: String)
}

/** Host-side route into the admitted Runtime Kernel; it is never installed in the Guest Realm. */
fun interface RuntimeTrustedBackendHost {
    fun invoke(
        channel: RuntimeTrustedBackendChannel,
        requestJson: String,
        sink: RuntimeTrustedBackendTerminalSink,
    )
}

/** One trusted Backend instance owned by exactly one Runtime generation. */
interface RuntimeTrustedBackend : AutoCloseable {
    fun start(host: RuntimeTrustedBackendHost)

    override fun close() = Unit
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

    override fun dispatch(
        requestId: String,
        requestJson: String,
        contextJson: String,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
        resourceSink: RuntimeNativeResourceEventSink,
    ) {
        dispatchCount += 1
        lastRequestJson = requestJson
        lastContextJson = contextJson
        sink.emit(RuntimeNativeEvent("{\"id\":\"$requestId\",$FAIL_CLOSED_TERMINAL_BODY"))
    }

    private companion object {
        private const val FAIL_CLOSED_TERMINAL_BODY =
            "\"type\":\"error\",\"error\":{\"domain\":\"runtime\",\"code\":\"capability_unsupported\"}}"
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

    /** Queues auxiliary adapter work on the dedicated runtime thread for the current generation. */
    fun requestRuntimeTask(callback: () -> Unit)

    /** Owns native monotonic timer records and delivers due IDs on the runtime thread. */
    fun scheduleTimer(
        delayMs: Long,
        intervalMs: Long?,
        callback: (Long) -> Unit,
    ): Long

    fun cancelTimer(timerId: Long): Boolean

    /** Queues termination after the current runtime callback unwinds. */
    fun requestTermination()
}

interface RuntimeAdapter : AutoCloseable {
    fun start()

    fun evaluate(source: String): RuntimeEvaluation

    fun executeModule(module: RuntimeModuleSource)

    fun control(operation: String, valueJson: String) {
        throw RuntimeEngineException(RuntimeEngineErrorCode.NOT_SUPPORTED, "Runtime control is unavailable")
    }

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

internal fun validateRuntimeControl(operation: String, valueJson: String): RuntimeEngineException? {
    if (!RUNTIME_CONTROL_OPERATION.matches(operation)) {
        return RuntimeEngineException(
            RuntimeEngineErrorCode.INVALID_ARGUMENT,
            "Invalid runtime control operation",
        )
    }
    if (valueJson.toByteArray(Charsets.UTF_8).size !in 1..MAX_RUNTIME_CONTROL_JSON_BYTES) {
        return RuntimeEngineException(
            RuntimeEngineErrorCode.INVALID_ARGUMENT,
            "Invalid runtime control value",
        )
    }
    return null
}

private const val MAX_RUNTIME_CONTROL_JSON_BYTES = 1024 * 1024
private val RUNTIME_CONTROL_OPERATION = Regex("[a-z][A-Za-z0-9_.-]{0,63}")
