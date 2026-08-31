package ai.oneworks.holonomy.v86

import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

interface AndroidV86EnvironmentBackend : AutoCloseable {
    fun start(host: RuntimeTrustedBackendHost): CompletableFuture<Unit>

    fun submit(command: JSONObject)
}

internal class AndroidV86EnvironmentLease(
    val backend: AndroidV86EnvironmentBackend,
    val environmentId: String,
    val scope: String,
    private val release: () -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    override fun close() {
        if (closed.compareAndSet(false, true)) release()
    }
}

/**
 * Generation-owned v86 environment selection. Runtime scope shares one Linux VM while processTree
 * scope owns one VM for each root ChildProcess resource.
 */
internal class AndroidV86EnvironmentManager(
    private val processId: String,
    private val generation: Long,
    private val defaultScope: String,
    private val startupTimeoutMs: Long,
    private val eventSink: AndroidV86ProcessEventSink,
    private val networkTransport: AndroidV86NetworkTransport?,
    private val backendFactory: (String, String, AndroidV86ProcessEventSink) -> AndroidV86EnvironmentBackend,
) : RuntimeTrustedBackend {
    private val closed = AtomicBoolean(false)
    private val host = AtomicReference<RuntimeTrustedBackendHost?>()
    private val lock = Any()
    private val records = linkedMapOf<String, Record>()
    private val started = AtomicBoolean(false)

    init {
        require(defaultScope == RUNTIME_SCOPE || defaultScope == PROCESS_TREE_SCOPE)
        require(startupTimeoutMs in 1..600_000)
    }

    override fun start(host: RuntimeTrustedBackendHost): CompletableFuture<Unit> {
        check(started.compareAndSet(false, true)) { "Android v86 environment manager already started" }
        check(!closed.get()) { "Android v86 environment manager is closed" }
        this.host.set(host)
        return if (defaultScope == RUNTIME_SCOPE) {
            ensureRecord(RUNTIME_SCOPE, RUNTIME_KEY).readiness
        } else {
            CompletableFuture.completedFuture(Unit)
        }
    }

    fun acquire(scope: String, processResourceId: String): AndroidV86EnvironmentLease {
        check(scope == RUNTIME_SCOPE || scope == PROCESS_TREE_SCOPE) { "Unsupported v86 environment scope" }
        check(started.get() && !closed.get()) { "Android v86 environment manager is unavailable" }
        val key = if (scope == RUNTIME_SCOPE) RUNTIME_KEY else "$PROCESS_TREE_SCOPE:$processResourceId"
        val record = ensureRecord(scope, key)
        try {
            record.readiness.get(startupTimeoutMs, TimeUnit.MILLISECONDS)
        } catch (error: Throwable) {
            if (scope == PROCESS_TREE_SCOPE) releaseRecord(key, record)
            throw error
        }
        return synchronized(lock) {
            check(!closed.get() && records[key] === record) {
                "Android v86 environment manager closed during acquisition"
            }
            AndroidV86EnvironmentLease(record.backend, record.environmentId, scope) {
                if (scope == PROCESS_TREE_SCOPE) releaseRecord(key, record)
            }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val owned = synchronized(lock) {
            records.values.toList().also { records.clear() }
        }
        owned.forEach { record -> runCatching { record.backend.close() } }
        runCatching { networkTransport?.close() }
        host.set(null)
    }

    fun invalidate(environmentId: String) {
        val removed = synchronized(lock) {
            val entry = records.entries.firstOrNull { (_, record) -> record.environmentId == environmentId }
            if (entry == null) null else records.remove(entry.key)
        }
        if (removed != null) runCatching { removed.backend.close() }
    }

    internal fun activeEnvironmentIds(): Set<String> = synchronized(lock) {
        records.values.mapTo(linkedSetOf(), Record::environmentId)
    }

    private fun ensureRecord(scope: String, key: String): Record = synchronized(lock) {
        check(!closed.get()) { "Android v86 environment manager is closed" }
        records[key]?.let { return@synchronized it }
        val trustedHost = checkNotNull(host.get()) { "Android v86 environment manager has not started" }
        val environmentId = "$processId:$generation:$key"
        val backend = backendFactory(
            environmentId,
            scope,
            AndroidV86ProcessEventSink { source ->
                eventSink.emit(source.put("environmentId", environmentId))
            },
        )
        Record(backend, environmentId, backend.start(trustedHost)).also { records[key] = it }
    }

    private fun releaseRecord(key: String, expected: Record) {
        val removed = synchronized(lock) {
            if (records[key] === expected) records.remove(key) else null
        }
        if (removed != null) runCatching { removed.backend.close() }
    }

    private data class Record(
        val backend: AndroidV86EnvironmentBackend,
        val environmentId: String,
        val readiness: CompletableFuture<Unit>,
    )

    private companion object {
        private const val PROCESS_TREE_SCOPE = "processTree"
        private const val RUNTIME_KEY = "runtime"
        private const val RUNTIME_SCOPE = "runtime"
    }
}
