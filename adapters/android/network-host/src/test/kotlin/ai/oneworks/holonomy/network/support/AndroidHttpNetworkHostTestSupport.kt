package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

internal data class ResourceFixture(
    val ownerCallToken: String,
    val providerToken: String,
    val reference: String = "resource:0",
)

internal class NetworkHostHarness(
    addresses: List<InetAddress> = listOf(InetAddress.getByName("8.8.8.8")),
    addressResolver: NetworkAddressResolver = ImmediateResolver { addresses },
    allowedOrigins: Set<String> = setOf("http://example.test"),
    connection: NetworkHttpConnection = FakeNetworkConnection(),
    limits: AndroidNetworkLimits = AndroidNetworkLimits(maxChunkBytes = 4),
    observation: AndroidNetworkObservationConfiguration = AndroidNetworkObservationConfiguration(),
    privateNetwork: PrivateNetworkPolicy = PrivateNetworkPolicy.ALLOW,
    worker: NetworkWorker = ImmediateWorker(),
    generation: AndroidNetworkProviderGeneration? = null,
    capabilityAuthority: AndroidCapabilityNetworkAuthority? = null,
) {
    var resolveCalls = 0
        private set
    val resourceEvents = CopyOnWriteArrayList<String>()
    var connectionCreates = 0
        private set
    val connectionTargets = CopyOnWriteArrayList<NetworkConnectionTarget>()
    private val connectionFactory = NetworkConnectionFactory { target, _ ->
        connectionCreates += 1
        connectionTargets += target
        connection
    }
    val host = createTestAndroidHttpNetworkHost(
        AndroidNetworkHostConfiguration(
            principal = "test-principal",
            allowedOrigins = allowedOrigins,
            privateNetwork = privateNetwork,
            limits = limits,
        ),
        NetworkHostDependencies(
            object : NetworkAddressResolver {
                override fun resolve(
                    host: String,
                    timeoutMs: Int,
                    callback: (Result<List<InetAddress>>) -> Unit,
                ): NetworkResolution {
                    resolveCalls += 1
                    return addressResolver.resolve(host, timeoutMs, callback)
                }

                override fun close() {
                    addressResolver.close()
                }
            },
            NetworkClock { 1_000L },
            connectionFactory,
            worker,
        ),
        observation,
        generation,
        capabilityAuthority,
    )

    fun openResource(capabilityBindingId: String? = null): ResourceFixture {
        val events = dispatch(
            id = "request",
            request = requestJson("request", NetworkV1.REQUEST, requestArgs(capabilityBindingId)),
            context = contextJson("call:request"),
        )
        val event = JSONObject(events.single().eventJson)
        val resources = event.get("resources") as JSONArray
        val resource = resources.get(0) as JSONObject
        return ResourceFixture("call:request", resource.get("providerToken") as String)
    }

    fun resourceCall(
        id: String,
        resource: ResourceFixture,
        operation: String,
        binary: List<RuntimeNativeBinary> = emptyList(),
        mode: String = "result",
    ): MutableList<RuntimeNativeEvent> = dispatch(
        id = id,
        request = requestJson(id, operation, "{\"response\":{\"resource\":\"${resource.reference}\"}}"),
        context = contextJson(
            callToken = "call:$id",
            mode = mode,
            resource = resource,
        ),
        binary = binary,
    )

    fun dispatch(
        id: String,
        request: String,
        context: String,
        binary: List<RuntimeNativeBinary> = emptyList(),
    ): MutableList<RuntimeNativeEvent> {
        val events = CopyOnWriteArrayList<RuntimeNativeEvent>()
        host.dispatch(
            id,
            request,
            context,
            binary,
            RuntimeNativeEventSink { events += it },
            RuntimeNativeResourceEventSink { resourceEvents += it },
        )
        return events
    }
}

private fun createTestAndroidHttpNetworkHost(
    configuration: AndroidNetworkHostConfiguration,
    dependencies: NetworkHostDependencies,
    observation: AndroidNetworkObservationConfiguration,
    generation: AndroidNetworkProviderGeneration?,
    capabilityAuthority: AndroidCapabilityNetworkAuthority?,
): AndroidHttpNetworkHost {
    val constructor = AndroidHttpNetworkHost::class.java.declaredConstructors.single { candidate ->
        candidate.parameterTypes.contentEquals(
            arrayOf(
                AndroidNetworkHostConfiguration::class.java,
                NetworkHostDependencies::class.java,
                AndroidNetworkObservationConfiguration::class.java,
                AndroidNetworkProviderGeneration::class.java,
                AndroidCapabilityNetworkAuthority::class.java,
            ),
        )
    }
    constructor.isAccessible = true
    return constructor.newInstance(
        configuration,
        dependencies,
        observation,
        generation,
        capabilityAuthority,
    ) as AndroidHttpNetworkHost
}

internal class ImmediateWorker : NetworkWorker {
    override fun execute(task: () -> Unit): Boolean {
        task()
        return true
    }

    override fun close() = Unit
}

internal class ImmediateResolver(
    private val answer: (String) -> List<InetAddress>,
) : NetworkAddressResolver {
    override fun resolve(
        host: String,
        timeoutMs: Int,
        callback: (Result<List<InetAddress>>) -> Unit,
    ): NetworkResolution {
        callback(runCatching { answer(host) })
        return NetworkResolution {}
    }
}

internal class ControlledResolver : NetworkAddressResolver {
    private val pending = CopyOnWriteArrayList<Pending>()
    var cancelCount = 0
        private set
    var closeCount = 0
        private set
    var lastTimeoutMs = 0
        private set

    val pendingCount: Int
        get() = pending.count { !it.settled.get() }

    override fun resolve(
        host: String,
        timeoutMs: Int,
        callback: (Result<List<InetAddress>>) -> Unit,
    ): NetworkResolution {
        lastTimeoutMs = timeoutMs
        return Pending(callback).also { pending += it }
    }

    fun acknowledgeCancellation() {
        pending.first { it.cancelRequested.get() && !it.settled.get() }
            .finish(Result.failure(NetworkResolutionCancelled()))
    }

    fun succeed(addresses: List<InetAddress>) {
        pending.first { !it.cancelRequested.get() && !it.settled.get() }
            .finish(Result.success(addresses))
    }

    fun timeout() {
        pending.first { !it.cancelRequested.get() && !it.settled.get() }
            .finish(Result.failure(java.net.SocketTimeoutException("deadline")))
    }

    override fun close() {
        closeCount += 1
        for (request in pending) request.cancel()
    }

    private inner class Pending(
        private val callback: (Result<List<InetAddress>>) -> Unit,
    ) : NetworkResolution {
        val cancelRequested = AtomicBoolean(false)
        val settled = AtomicBoolean(false)

        override fun cancel() {
            if (cancelRequested.compareAndSet(false, true)) cancelCount += 1
        }

        fun finish(result: Result<List<InetAddress>>) {
            if (settled.compareAndSet(false, true)) callback(result)
        }
    }
}

internal class SingleTaskWorker : NetworkWorker {
    val finished = CountDownLatch(1)
    private val accepted = AtomicBoolean(false)
    private var thread: Thread? = null

    override fun execute(task: () -> Unit): Boolean {
        if (!accepted.compareAndSet(false, true)) return false
        thread = Thread {
            try {
                task()
            } finally {
                finished.countDown()
            }
        }.apply {
            isDaemon = true
            start()
        }
        return true
    }

    override fun close() {
        thread?.interrupt()
    }
}

internal class BlockingNetworkConnection : NetworkHttpConnection {
    val entered = CountDownLatch(1)
    var closeCount = 0
        private set
    private val closed = CountDownLatch(1)
    private val closedOnce = AtomicBoolean(false)

    override fun execute(
        request: NetworkTransportRequest,
        limits: AndroidNetworkLimits,
    ): NetworkTransportResponse {
        entered.countDown()
        check(closed.await(1, TimeUnit.SECONDS))
        throw SocketException("closed")
    }

    override fun close() {
        if (!closedOnce.compareAndSet(false, true)) return
        closeCount += 1
        closed.countDown()
    }
}

internal class StalledBodySocket(
    responseHead: ByteArray,
) : Socket() {
    private val closed = CountDownLatch(1)
    private val closedOnce = AtomicBoolean(false)
    private val input = PrefixThenBlockingInput(responseHead, closed)
    private val output = ByteArrayOutputStream()
    val bodyReadEntered: CountDownLatch
        get() = input.blocked
    var closeCount = 0
        private set

    override fun connect(endpoint: SocketAddress, timeout: Int) = Unit

    override fun getInputStream(): InputStream = input

    override fun getOutputStream(): OutputStream = output

    override fun setSoTimeout(timeout: Int) = Unit

    override fun setTcpNoDelay(on: Boolean) = Unit

    override fun close() {
        if (!closedOnce.compareAndSet(false, true)) return
        closeCount += 1
        closed.countDown()
    }
}

internal class PrefixThenBlockingInput(
    private val prefix: ByteArray,
    private val closed: CountDownLatch,
) : InputStream() {
    val blocked = CountDownLatch(1)
    private var offset = 0

    override fun read(): Int {
        val single = ByteArray(1)
        return if (read(single, 0, 1) < 0) -1 else single[0].toInt() and 0xFF
    }

    override fun read(buffer: ByteArray, destinationOffset: Int, length: Int): Int {
        if (destinationOffset < 0 || length < 0 || destinationOffset > buffer.size - length) {
            throw IndexOutOfBoundsException()
        }
        if (length == 0) return 0
        if (offset < prefix.size) {
            val count = minOf(length, prefix.size - offset)
            prefix.copyInto(buffer, destinationOffset, offset, offset + count)
            offset += count
            return count
        }
        blocked.countDown()
        check(closed.await(1, TimeUnit.SECONDS))
        throw SocketException("closed during response body read")
    }
}

internal class FakeNetworkConnection(
    body: ByteArray = ByteArray(0),
    private val contentLength: Long = body.size.toLong(),
    private val headers: List<Pair<String, String>> = emptyList(),
    private val responseStatus: Int = 200,
) : NetworkHttpConnection {
    val uploaded = ByteArrayOutputStream()
    var disconnects = 0
        private set
    private val responseBytes = body.copyOf()

    override fun execute(
        request: NetworkTransportRequest,
        limits: AndroidNetworkLimits,
    ): NetworkTransportResponse {
        if (contentLength > limits.maxResponseBodyBytes) throw HttpResponseLimitExceeded()
        for (chunk in request.chunks) uploaded.write(chunk)
        return NetworkTransportResponse(
            body = if (responseBytes.isEmpty()) null else ByteArrayInputStream(responseBytes),
            headers = headers,
            status = responseStatus,
            statusText = "OK",
        )
    }

    override fun close() {
        disconnects += 1
    }
}

internal fun requestArgs(capabilityBindingId: String? = null): String = JSONObject()
    .apply { if (capabilityBindingId != null) put("capabilityBindingId", capabilityBindingId) }
    .put("headers", JSONArray())
    .put("method", "POST")
    .put("url", "http://example.test/")
    .toString()

internal fun requestJson(id: String, operation: String, args: String, extra: String = ""): String =
    "{$extra\"args\":$args,\"id\":\"$id\",\"module\":\"host.network\",\"operation\":\"$operation\"}"

internal fun contextJson(
    callToken: String,
    mode: String = "result",
    principal: String = "test-principal",
    resource: ResourceFixture? = null,
): String {
    val resources = if (resource == null) {
        "[]"
    } else {
        "[{\"ownerCallToken\":\"${resource.ownerCallToken}\",\"providerToken\":\"${resource.providerToken}\"," +
            "\"reference\":{\"resource\":\"${resource.reference}\"},\"type\":\"network.http\"}]"
    }
    return "{\"authority\":{\"capabilities\":[\"host.network.http\"],\"principal\":\"$principal\"}," +
        "\"callToken\":\"$callToken\",\"mode\":\"$mode\",\"resources\":$resources}"
}

internal fun RuntimeNativeEvent.type(): String = JSONObject(eventJson).get("type") as String

internal fun RuntimeNativeEvent.errorCode(): String {
    val error = JSONObject(eventJson).get("error") as JSONObject
    return error.get("code") as String
}

internal fun RuntimeNativeEvent.envelope(): JSONObject = JSONObject(eventJson).get("value") as JSONObject

internal fun RuntimeNativeEvent.networkValue(): JSONObject = envelope().get("value") as JSONObject
