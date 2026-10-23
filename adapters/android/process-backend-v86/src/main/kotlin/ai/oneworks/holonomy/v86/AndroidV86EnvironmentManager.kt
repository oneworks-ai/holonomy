package ai.oneworks.holonomy.v86

import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
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
    val readiness: CompletableFuture<Unit>,
    private val submitCurrent: (JSONObject) -> Unit,
    private val release: () -> Unit,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    fun submit(command: JSONObject) {
        check(!closed.get()) { "Android v86 environment lease is closed" }
        submitCurrent(command)
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) release()
    }
}

/**
 * Generation-owned v86 environment selection. Every root ChildProcess owns a VM;
 * shared runtime scope is unavailable until network packets carry kernel-bound PID identity.
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
    private val startupExecutor = Executors.newSingleThreadScheduledExecutor { task ->
        Thread(task, "holonomy-v86-startup-timeout").apply { isDaemon = true }
    }

    init {
        require(defaultScope == PROCESS_TREE_SCOPE)
        require(startupTimeoutMs in 1..600_000)
    }

    override fun start(host: RuntimeTrustedBackendHost): CompletableFuture<Unit> {
        check(started.compareAndSet(false, true)) { "Android v86 environment manager already started" }
        check(!closed.get()) { "Android v86 environment manager is closed" }
        this.host.set(host)
        return CompletableFuture.completedFuture(Unit)
    }

    fun acquire(scope: String, processResourceId: String): AndroidV86EnvironmentLease {
        check(scope == PROCESS_TREE_SCOPE) { "Unsupported v86 environment scope" }
        check(started.get() && !closed.get()) { "Android v86 environment manager is unavailable" }
        val key = "$PROCESS_TREE_SCOPE:$processResourceId"
        val record = ensureRecord(scope, key)
        return AndroidV86EnvironmentLease(
            record.backend, record.environmentId, scope, record.readiness,
            submitCurrent = { command ->
                synchronized(lock) {
                    check(!closed.get() && records[key] === record) { "Android v86 environment is stale" }
                    record.backend.submit(command)
                }
            },
            release = { releaseRecord(key, record) },
        )
    }

    override fun close() {
        val owned = synchronized(lock) {
            if (!closed.compareAndSet(false, true)) return
            records.values.toList().also { records.clear() }
        }
        startupExecutor.shutdownNow()
        owned.forEach { record -> retire(record) }
        runCatching { networkTransport?.close() }
        host.set(null)
    }

    fun invalidate(environmentId: String) {
        val removed = synchronized(lock) {
            val entry = records.entries.firstOrNull { (_, record) -> record.environmentId == environmentId }
            if (entry == null) null else records.remove(entry.key)
        }
        if (removed != null) retire(removed)
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
        val record = Record(backend, environmentId, CompletableFuture())
        records[key] = record
        record.timeout = startupExecutor.schedule({
            if (record.readiness.completeExceptionally(TimeoutException("Android v86 startup timed out"))) {
                releaseRecord(key, record)
            }
        }, startupTimeoutMs, TimeUnit.MILLISECONDS)
        runCatching { backend.start(trustedHost) }.fold(
            onSuccess = { readiness -> readiness.whenComplete { _, error ->
                record.timeout?.cancel(false)
                if (error == null) record.readiness.complete(Unit) else {
                    record.readiness.completeExceptionally(error)
                    releaseRecord(key, record)
                }
            } },
            onFailure = { error ->
                record.readiness.completeExceptionally(error)
                releaseRecord(key, record)
            },
        )
        record
    }

    private fun releaseRecord(key: String, expected: Record) {
        val removed = synchronized(lock) {
            if (records[key] === expected) records.remove(key) else null
        }
        if (removed != null) retire(removed)
    }

    private fun retire(record: Record) {
        record.timeout?.cancel(false)
        record.readiness.completeExceptionally(IllegalStateException("Android v86 environment closed"))
        // Production Backend close has a bounded ten-second join and skips its own worker.
        runCatching { record.backend.close() }
    }

    private data class Record(
        val backend: AndroidV86EnvironmentBackend,
        val environmentId: String,
        val readiness: CompletableFuture<Unit>,
        var timeout: ScheduledFuture<*>? = null,
    )

    private companion object {
        private const val PROCESS_TREE_SCOPE = "processTree"
    }
}
