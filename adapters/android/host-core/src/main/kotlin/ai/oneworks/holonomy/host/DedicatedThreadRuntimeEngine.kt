package ai.oneworks.holonomy.host

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class DedicatedThreadRuntimeEngine(
    private val adapterFactory: RuntimeAdapterFactory,
) : RuntimeEngine {
    override val capabilities: RuntimeCapabilities = adapterFactory.capabilities

    private val schedulingLock = Any()
    private val generation = AtomicLong(0)
    private val adapter = AtomicReference<RuntimeAdapter?>()
    private val disposeFuture = CompletableFuture<Unit>()
    private val threadGuard: RuntimeThreadGuard
    private val executor: ExecutorService
    private val wakeupExecutor: ScheduledExecutorService
    private var scheduledWakeup: ScheduledFuture<*>? = null
    private var scheduledWakeupAt: Long? = null
    private var wakeupSequence = 0L
    private val nativeTimers = mutableMapOf<Long, NativeTimerRecord>()
    private var nextNativeTimerId = 0L

    @Volatile
    private var lifecycle = Lifecycle.ACTIVE

    init {
        val threadName = "oneworks-v8-${nextEngineId.incrementAndGet()}"
        threadGuard = RuntimeThreadGuard(threadName)
        executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(
                {
                    threadGuard.bindToCurrentThread()
                    runnable.run()
                },
                threadName,
            ).apply { isDaemon = true }
        }
        wakeupExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "$threadName-wakeup").apply { isDaemon = true }
        }
    }

    override fun start(): CompletableFuture<Unit> = submitOperation { runtimeAdapter ->
        runtimeAdapter.start()
    }

    override fun evaluate(source: String): CompletableFuture<RuntimeEvaluation> {
        if (source.isBlank()) {
            return failedFuture(
                RuntimeEngineException(
                    RuntimeEngineErrorCode.INVALID_ARGUMENT,
                    "JavaScript source must not be blank",
                ),
            )
        }
        return submitOperation { runtimeAdapter -> runtimeAdapter.evaluate(source) }
    }

    override fun executeModule(module: RuntimeModuleSource): CompletableFuture<Unit> {
        validateModuleSource(module)?.let { return failedFuture(it) }
        return submitOperation { runtimeAdapter -> runtimeAdapter.executeModule(module) }
    }

    override fun control(operation: String, valueJson: String): CompletableFuture<Unit> {
        validateRuntimeControl(operation, valueJson)?.let { return failedFuture(it) }
        return submitOperation { runtimeAdapter -> runtimeAdapter.control(operation, valueJson) }
    }

    override fun terminate(): CompletableFuture<Unit> {
        val future = CompletableFuture<Unit>()
        synchronized(schedulingLock) {
            if (lifecycle != Lifecycle.ACTIVE) {
                return failedFuture(disposedError())
            }

            generation.incrementAndGet()
            cancelWakeupLocked()
            cancelNativeTimersLocked()
            val terminationError = runCatching { adapter.get()?.terminateExecution() }.exceptionOrNull()
            executor.execute {
                threadGuard.checkAccess()
                val closeError = runCatching { adapter.getAndSet(null)?.close() }.exceptionOrNull()
                val recreationError = if (lifecycle == Lifecycle.ACTIVE) {
                    runCatching { adapter.set(createRuntimeAdapter()) }.exceptionOrNull()
                } else {
                    null
                }
                val error = terminationError ?: closeError ?: recreationError
                if (error == null) {
                    future.complete(Unit)
                } else {
                    future.completeExceptionally(normalizeError(error))
                }
            }
        }
        return future
    }

    override fun dispose(): CompletableFuture<Unit> {
        synchronized(schedulingLock) {
            if (lifecycle != Lifecycle.ACTIVE) {
                return disposeFuture
            }

            lifecycle = Lifecycle.DISPOSING
            generation.incrementAndGet()
            cancelWakeupLocked()
            cancelNativeTimersLocked()
            wakeupExecutor.shutdownNow()
            val terminationError = runCatching { adapter.get()?.terminateExecution() }.exceptionOrNull()
            executor.execute {
                threadGuard.checkAccess()
                val closeError = runCatching { adapter.getAndSet(null)?.close() }.exceptionOrNull()
                lifecycle = Lifecycle.DISPOSED
                val error = terminationError ?: closeError
                if (error == null) {
                    disposeFuture.complete(Unit)
                } else {
                    disposeFuture.completeExceptionally(normalizeError(error))
                }
                executor.shutdown()
            }
            return disposeFuture
        }
    }

    private fun <T> submitOperation(operation: (RuntimeAdapter) -> T): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        synchronized(schedulingLock) {
            if (lifecycle != Lifecycle.ACTIVE) {
                return failedFuture(disposedError())
            }
            val operationGeneration = generation.get()
            executor.execute {
                threadGuard.checkAccess()
                try {
                    if (generation.get() != operationGeneration) {
                        throw terminatedError()
                    }
                    val runtimeAdapter = adapter.get() ?: createRuntimeAdapter().also(adapter::set)
                    if (generation.get() != operationGeneration) {
                        throw terminatedError()
                    }
                    val result = operation(runtimeAdapter)
                    if (generation.get() != operationGeneration) {
                        throw terminatedError()
                    }
                    future.complete(result)
                } catch (error: Throwable) {
                    val normalizedError = if (generation.get() != operationGeneration) {
                        terminatedError()
                    } else {
                        normalizeError(error)
                    }
                    future.completeExceptionally(normalizedError)
                }
            }
        }
        return future
    }

    private fun createRuntimeAdapter(): RuntimeAdapter {
        val adapterGeneration = generation.get()
        val host = object : RuntimeAdapterHost {
            override fun requestWakeup(
                deadlineMs: Long?,
                observedNowMs: Long,
                callback: () -> Unit,
            ) = scheduleWakeup(adapterGeneration, deadlineMs, observedNowMs, callback)

            override fun requestRuntimeTask(callback: () -> Unit) =
                enqueueRuntimeTask(adapterGeneration, callback)

            override fun scheduleTimer(
                delayMs: Long,
                intervalMs: Long?,
                callback: (Long) -> Unit,
            ): Long = scheduleNativeTimer(adapterGeneration, delayMs, intervalMs, callback)

            override fun cancelTimer(timerId: Long): Boolean = cancelNativeTimer(adapterGeneration, timerId)

            override fun requestTermination() = requestFatalTermination(adapterGeneration)
        }
        return adapterFactory.create(threadGuard, host)
    }

    private fun scheduleWakeup(
        adapterGeneration: Long,
        deadlineMs: Long?,
        observedNowMs: Long,
        callback: () -> Unit,
    ) {
        synchronized(schedulingLock) {
            if (lifecycle != Lifecycle.ACTIVE || generation.get() != adapterGeneration) return
            if (deadlineMs == null) {
                cancelWakeupLocked()
                return
            }
            if (deadlineMs < 0L || observedNowMs < 0L) {
                requestFatalTermination(adapterGeneration)
                return
            }
            if (scheduledWakeupAt == deadlineMs && scheduledWakeup?.isDone == false) return

            cancelWakeupLocked()
            val sequence = ++wakeupSequence
            scheduledWakeupAt = deadlineMs
            val delayMs = (deadlineMs - observedNowMs).coerceAtLeast(0L)
            scheduledWakeup = wakeupExecutor.schedule(
                { enqueueWakeup(adapterGeneration, sequence, deadlineMs, callback) },
                delayMs,
                TimeUnit.MILLISECONDS,
            )
        }
    }

    private fun enqueueRuntimeTask(adapterGeneration: Long, callback: () -> Unit) {
        synchronized(schedulingLock) {
            if (lifecycle != Lifecycle.ACTIVE || generation.get() != adapterGeneration) return
            executor.execute {
                threadGuard.checkAccess()
                if (lifecycle != Lifecycle.ACTIVE || generation.get() != adapterGeneration) return@execute
                runCatching(callback).onFailure { requestFatalTermination(adapterGeneration) }
            }
        }
    }

    private fun scheduleNativeTimer(
        adapterGeneration: Long,
        delayMs: Long,
        intervalMs: Long?,
        callback: (Long) -> Unit,
    ): Long = synchronized(schedulingLock) {
        check(lifecycle == Lifecycle.ACTIVE && generation.get() == adapterGeneration) {
            "The runtime timer generation is inactive"
        }
        require(delayMs >= 0L && (intervalMs == null || intervalMs >= 0L)) {
            "Runtime timer delays must be non-negative"
        }
        val timerId = ++nextNativeTimerId
        val deadlineMs = monotonicNowMs() + delayMs
        val record = NativeTimerRecord(
            callback = callback,
            deadlineMs = deadlineMs,
            generation = adapterGeneration,
            id = timerId,
            intervalMs = intervalMs,
        )
        nativeTimers[timerId] = record
        scheduleNativeTimerLocked(record)
        timerId
    }

    private fun cancelNativeTimer(adapterGeneration: Long, timerId: Long): Boolean = synchronized(schedulingLock) {
        if (lifecycle != Lifecycle.ACTIVE || generation.get() != adapterGeneration) return@synchronized false
        val record = nativeTimers.remove(timerId) ?: return@synchronized false
        record.future?.cancel(false)
        record.future = null
        true
    }

    private fun scheduleNativeTimerLocked(record: NativeTimerRecord) {
        val delayMs = (record.deadlineMs - monotonicNowMs()).coerceAtLeast(0L)
        record.future = wakeupExecutor.schedule(
            { deliverNativeTimer(record.id, record.generation) },
            delayMs,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun deliverNativeTimer(timerId: Long, adapterGeneration: Long) {
        val delivery = synchronized(schedulingLock) {
            val record = nativeTimers[timerId]
            if (
                record == null ||
                lifecycle != Lifecycle.ACTIVE ||
                generation.get() != adapterGeneration ||
                record.generation != adapterGeneration
            ) return@synchronized null
            record.future = null
            if (record.intervalMs == null) {
                nativeTimers.remove(timerId)
            } else {
                record.deliveryQueued = true
            }
            record
        } ?: return
        executor.execute {
            threadGuard.checkAccess()
            val admitted = synchronized(schedulingLock) {
                lifecycle == Lifecycle.ACTIVE &&
                    generation.get() == adapterGeneration &&
                    (delivery.intervalMs == null || nativeTimers[timerId] === delivery)
            }
            if (!admitted) return@execute
            val error = runCatching { delivery.callback(timerId) }.exceptionOrNull()
            if (error != null) {
                requestFatalTermination(adapterGeneration)
                return@execute
            }
            synchronized(schedulingLock) {
                if (
                    lifecycle != Lifecycle.ACTIVE ||
                    generation.get() != adapterGeneration ||
                    nativeTimers[timerId] !== delivery
                ) return@synchronized
                val intervalMs = delivery.intervalMs ?: return@synchronized
                delivery.deliveryQueued = false
                val now = monotonicNowMs()
                val step = intervalMs.coerceAtLeast(1L)
                val missed = ((now - delivery.deadlineMs).coerceAtLeast(0L) / step) + 1L
                delivery.deadlineMs += missed * step
                scheduleNativeTimerLocked(delivery)
            }
        }
    }

    private fun enqueueWakeup(
        adapterGeneration: Long,
        sequence: Long,
        deadlineMs: Long,
        callback: () -> Unit,
    ) {
        synchronized(schedulingLock) {
            if (
                lifecycle != Lifecycle.ACTIVE ||
                generation.get() != adapterGeneration ||
                wakeupSequence != sequence ||
                scheduledWakeupAt != deadlineMs
            ) return
            scheduledWakeup = null
            scheduledWakeupAt = null
            executor.execute {
                threadGuard.checkAccess()
                if (lifecycle != Lifecycle.ACTIVE || generation.get() != adapterGeneration) return@execute
                try {
                    callback()
                } catch (_: Throwable) {
                    requestFatalTermination(adapterGeneration)
                }
            }
        }
    }

    private fun requestFatalTermination(adapterGeneration: Long) {
        synchronized(schedulingLock) {
            if (lifecycle != Lifecycle.ACTIVE || generation.get() != adapterGeneration) return
            generation.incrementAndGet()
            cancelWakeupLocked()
            cancelNativeTimersLocked()
            executor.execute {
                threadGuard.checkAccess()
                runCatching { adapter.getAndSet(null)?.close() }
                if (lifecycle == Lifecycle.ACTIVE) {
                    runCatching { adapter.set(createRuntimeAdapter()) }
                }
            }
        }
    }

    private fun cancelWakeupLocked() {
        wakeupSequence += 1
        scheduledWakeup?.cancel(false)
        scheduledWakeup = null
        scheduledWakeupAt = null
    }

    private fun cancelNativeTimersLocked() {
        nativeTimers.values.forEach { record -> record.future?.cancel(false) }
        nativeTimers.clear()
    }

    private data class NativeTimerRecord(
        val callback: (Long) -> Unit,
        var deadlineMs: Long,
        val generation: Long,
        val id: Long,
        val intervalMs: Long?,
        var deliveryQueued: Boolean = false,
        var future: ScheduledFuture<*>? = null,
    )

    private enum class Lifecycle {
        ACTIVE,
        DISPOSING,
        DISPOSED,
    }

    private companion object {
        private val nextEngineId = AtomicLong(0)

        private fun monotonicNowMs(): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime())

        private fun disposedError(): RuntimeEngineException = RuntimeEngineException(
            RuntimeEngineErrorCode.DISPOSED,
            "The runtime engine has been disposed",
        )

        private fun terminatedError(): RuntimeEngineException = RuntimeEngineException(
            RuntimeEngineErrorCode.TERMINATED,
            "The runtime operation was terminated",
        )

        private fun normalizeError(error: Throwable): RuntimeEngineException =
            if (error is RuntimeEngineException) {
                error
            } else {
                RuntimeEngineException(
                    RuntimeEngineErrorCode.INTERNAL,
                    "The runtime engine operation failed",
                )
            }

        private fun <T> failedFuture(error: RuntimeEngineException): CompletableFuture<T> =
            CompletableFuture<T>().also { it.completeExceptionally(error) }
    }
}
