package ai.oneworks.holonomy.network

import android.net.DnsResolver
import android.os.CancellationSignal
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal class AndroidNetworkAddressResolver : NetworkAddressResolver {
    private val closed = AtomicBoolean(false)
    private val requests = ConcurrentHashMap.newKeySet<ResolutionRequest>()
    private val scheduler = ScheduledThreadPoolExecutor(1) { task ->
        Thread(task, "holonomy-dns-deadline").apply { isDaemon = true }
    }.apply {
        removeOnCancelPolicy = true
        maximumPoolSize = 1
    }

    override fun resolve(
        host: String,
        timeoutMs: Int,
        callback: (Result<List<InetAddress>>) -> Unit,
    ): NetworkResolution {
        require(timeoutMs > 0)
        if (closed.get()) {
            callback(Result.failure(NetworkResolutionCancelled()))
            return NetworkResolution {}
        }
        val request = ResolutionRequest(callback) { requests.remove(it) }
        requests += request
        if (closed.get()) {
            request.cancel()
            return request
        }
        try {
            request.deadline = scheduler.schedule({ request.timeout() }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
            if (request.settled.get()) request.deadline?.cancel(false)
            DnsResolver.getInstance().query(
                null,
                host,
                DnsResolver.FLAG_EMPTY,
                DIRECT_EXECUTOR,
                request.cancellationSignal,
                object : DnsResolver.Callback<List<InetAddress>> {
                    override fun onAnswer(answer: List<InetAddress>, rcode: Int) {
                        val copied = answer.map { InetAddress.getByAddress(it.address.copyOf()) }
                        request.finish(
                            if (copied.isEmpty()) {
                                Result.failure(UnknownHostException("DNS resolution failed"))
                            } else {
                                Result.success(copied)
                            },
                        )
                    }

                    override fun onError(error: DnsResolver.DnsException) {
                        request.finish(Result.failure(UnknownHostException("DNS resolution failed")))
                    }
                },
            )
        } catch (error: Throwable) {
            request.finish(Result.failure(error))
        }
        return request
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        for (request in requests.toList()) request.cancel()
        scheduler.shutdownNow()
    }

    private class ResolutionRequest(
        private val callback: (Result<List<InetAddress>>) -> Unit,
        private val release: (ResolutionRequest) -> Unit,
    ) : NetworkResolution {
        val cancellationSignal = CancellationSignal()
        val settled = AtomicBoolean(false)
        var deadline: ScheduledFuture<*>? = null

        override fun cancel() {
            finish(Result.failure(NetworkResolutionCancelled()))
            runCatching { cancellationSignal.cancel() }
        }

        fun timeout() {
            finish(Result.failure(SocketTimeoutException("DNS deadline exceeded")))
            runCatching { cancellationSignal.cancel() }
        }

        fun finish(result: Result<List<InetAddress>>) {
            if (!settled.compareAndSet(false, true)) return
            deadline?.cancel(false)
            release(this)
            callback(result)
        }
    }

    private companion object {
        val DIRECT_EXECUTOR = Executor(Runnable::run)
    }
}

internal class NetworkResolutionCancelled : RuntimeException()
