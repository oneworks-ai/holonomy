package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import java.io.InputStream
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException
import kotlin.math.min
import org.json.JSONArray
import org.json.JSONObject

class AndroidHttpNetworkHost private constructor(
    private val configuration: AndroidNetworkHostConfiguration,
    private val dependencies: NetworkHostDependencies,
    observation: AndroidNetworkObservationConfiguration,
    private val generation: AndroidNetworkProviderGeneration?,
) : RuntimeNativeHost {
    constructor(configuration: AndroidNetworkHostConfiguration) : this(
        configuration,
        NetworkHostDependencies.platform(configuration.limits),
        AndroidNetworkObservationConfiguration(),
        null,
    )

    private enum class ExchangePhase {
        AUTHORIZING,
        ACCEPTED,
        UPLOADING,
        EXECUTING,
        RESPONSE,
        READING,
        CANCELLED,
        CLOSED,
    }

    private class Exchange(
        val metadata: HttpRequestMetadata,
        val ownerCallToken: String,
        val principal: String,
        val providerToken: String,
        val resourceSink: RuntimeNativeResourceEventSink,
        val observationSequence: Long,
        val startedAtMs: Long,
    ) {
        val closed = AtomicBoolean(false)
        val observationTerminal = AtomicBoolean(false)
        val backgroundTasks = AtomicInteger(0)
        val lock = Any()
        val slotReleased = AtomicBoolean(false)
        var connection: NetworkHttpConnection? = null
        var phase = ExchangePhase.AUTHORIZING
        var resolution: NetworkResolution? = null
        var requestBodyBytes = 0L
        var requestChunks = mutableListOf<ByteArray>()
        var resolvedAddresses = emptyList<ByteArray>()
        var responseBody: InputStream? = null
        var responseBytes = 0L
        var responseStatus: Int? = null
    }

    private class PendingCall(
        val exchange: Exchange,
        val requestId: String,
        val sink: RuntimeNativeEventSink,
        val stream: Boolean = false,
    ) {
        val active = AtomicBoolean(true)
        val credits = AtomicInteger(0)
        val deliveryLock = Any()
        val draining = AtomicBoolean(false)
        val sequence = AtomicInteger(0)
    }

    private class ObservationDispatcher(
        configuration: AndroidNetworkObservationConfiguration,
    ) : AutoCloseable {
        private val closed = AtomicBoolean(false)
        private val observer = AtomicReference(
            configuration.observer.takeUnless { it === AndroidNetworkObserver.NONE },
        )
        private val executor = if (observer.get() == null) {
            null
        } else {
            ThreadPoolExecutor(
                1,
                1,
                0L,
                TimeUnit.MILLISECONDS,
                ArrayBlockingQueue(configuration.maxPendingObservations),
                { task ->
                    Thread(task, "holonomy-network-observer-${THREAD_IDS.getAndIncrement()}").apply {
                        isDaemon = true
                    }
                },
                ThreadPoolExecutor.DiscardPolicy(),
            )
        }

        fun publish(observation: AndroidNetworkObservation) {
            val target = executor ?: return
            if (closed.get()) return
            runCatching {
                val snapshot = observation.frozenCopy()
                target.execute {
                    if (closed.get()) return@execute
                    val callback = observer.get() ?: return@execute
                    if (closed.get()) return@execute
                    runCatching { callback.onObservation(snapshot) }
                }
            }
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            observer.set(null)
            runCatching { executor?.shutdownNow()?.clear() }
        }

        private companion object {
            val THREAD_IDS = AtomicInteger(1)
        }
    }

    private val activeConnections = AtomicInteger(0)
    private val calls = ConcurrentHashMap<String, PendingCall>()
    private val closed = AtomicBoolean(false)
    private val nextResource = AtomicLong(1)
    private val nextObservation = AtomicLong(1)
    private val observations = ObservationDispatcher(observation)
    private val ownerResources = ConcurrentHashMap<String, Exchange>()
    private val resources = ConcurrentHashMap<String, Exchange>()

    override fun configurationJson(): String = JSONObject()
        .put("capabilities", JSONArray().put(NetworkV1.MODULE_CAPABILITY))
        .put("principal", configuration.principal)
        .put(
            "network",
            JSONObject()
                .put("allowedOrigins", JSONArray(configuration.allowedOrigins.sorted()))
                .put("allowedSchemes", JSONArray(configuration.allowedSchemes.sorted()))
                .put(
                    "limits",
                    JSONObject()
                        .put("maxChunkBytes", configuration.limits.maxChunkBytes)
                        .put("maxConcurrentConnections", configuration.limits.maxConcurrentConnections)
                        .put("maxHeaderBytes", configuration.limits.maxHeaderBytes)
                        .put("maxHeaders", configuration.limits.maxHeaders)
                        .put("maxRedirects", 10)
                        .put("maxRequestBodyBytes", configuration.limits.maxRequestBodyBytes)
                        .put("maxResponseBodyBytes", configuration.limits.maxResponseBodyBytes)
                        .put("maxWebSocketBufferedBytes", 1024 * 1024)
                        .put("maxWebSocketMessageBytes", 1024 * 1024),
                )
                .put(
                    "privateNetwork",
                    if (configuration.privateNetwork == PrivateNetworkPolicy.ALLOW) "allow" else "deny",
                ),
        )
        .toString()

    override fun dispatch(
        requestId: String,
        requestJson: String,
        contextJson: String,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
        resourceSink: RuntimeNativeResourceEventSink,
    ) {
        if (closed.get()) return sink.safeEmit(failure(requestId, "disposed"))
        val parsed = runCatching {
            parseProviderRequest(requestId, requestJson) to parseProviderContext(contextJson)
        }.getOrElse {
            sink.safeEmit(failure(requestId, "invalid_request"))
            return
        }
        val (request, context) = parsed
        if (
            request.module != NetworkV1.MODULE ||
            NetworkV1.MODULE_CAPABILITY !in context.capabilities ||
            context.principal != configuration.principal
        ) {
            sink.safeEmit(failure(request.id, "capability_unsupported"))
            return
        }
        if (request.operation !in NetworkV1.operations) {
            sink.safeEmit(failure(request.id, "operation_unsupported"))
            return
        }
        val expectedMode = if (request.operation == NetworkV1.READ_BODY) "stream" else "result"
        if (context.mode != expectedMode) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        if (isExpired(request)) {
            sink.safeEmit(failure(request.id, "timeout", "network", "host"))
            return
        }
        if (request.operation == NetworkV1.REQUEST) {
            openRequest(request, context, binary, sink, resourceSink)
            return
        }
        val exchange = resolveExchange(request.args, context)
        if (exchange == null) {
            sink.safeEmit(failure(request.id, "resource_invalid"))
            return
        }
        if (!reauthorizeExchange(exchange)) {
            sink.safeEmit(failure(request.id, "capability_unsupported"))
            return
        }
        when (request.operation) {
            NetworkV1.OPEN_BODY -> openBody(request, exchange, binary, sink)
            NetworkV1.WRITE_BODY -> writeBody(request, exchange, binary, sink)
            NetworkV1.FINISH_BODY -> finishBody(request, context, exchange, binary, sink)
            NetworkV1.READ_BODY -> readBody(request, context, exchange, binary, sink)
            NetworkV1.CANCEL -> cancelExchange(request, exchange, binary, sink)
            NetworkV1.CLOSE -> closeRequest(request, exchange, binary, sink)
        }
    }

    override fun cancel(callToken: String, reason: String?) {
        val call = calls.remove(callToken)
        if (call != null) {
            cancelPending(call)
            closeExchange(call.exchange, revoke = false, terminalState = AndroidNetworkTerminalState.CANCELLED)
            return
        }
        ownerResources[callToken]?.let { exchange ->
            closeExchange(exchange, revoke = false, terminalState = AndroidNetworkTerminalState.CANCELLED)
        }
    }

    override fun closeResource(ownerCallToken: String, providerToken: String, reason: String?) {
        val exchange = resources[providerToken] ?: return
        if (exchange.ownerCallToken != ownerCallToken) return
        closeExchange(exchange, revoke = false, terminalState = AndroidNetworkTerminalState.CLOSED)
    }

    override fun grantCredits(callToken: String, credits: Int) {
        if (credits <= 0) return
        val call = calls[callToken] ?: return
        if (!call.active.get() || !call.stream) return
        while (true) {
            val current = call.credits.get()
            val updated = min(MAX_CREDITS.toLong(), current.toLong() + credits).toInt()
            if (call.credits.compareAndSet(current, updated)) break
        }
        scheduleDrain(callToken, call)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val pending = calls.values.toSet()
        calls.clear()
        for (call in pending) cancelPending(call)
        val exchanges = (resources.values + pending.map { it.exchange }).toSet()
        for (exchange in exchanges) {
            closeExchange(
                exchange,
                revoke = resources.containsKey(exchange.providerToken),
                terminalState = AndroidNetworkTerminalState.DISPOSED,
            )
        }
        resources.clear()
        ownerResources.clear()
        dependencies.addressResolver.close()
        dependencies.worker.close()
        observations.close()
    }

    private fun openRequest(
        request: ProviderRequest,
        context: ProviderContext,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
        resourceSink: RuntimeNativeResourceEventSink,
    ) {
        if (binary.isNotEmpty() || context.resources.isNotEmpty()) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        val metadata = try {
            parseHttpRequestMetadata(request.args, configuration)
        } catch (_: HttpRequestLimitExceeded) {
            sink.safeEmit(failure(request.id, "limit_exceeded"))
            return
        } catch (_: Throwable) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        val observationSequence = nextObservation.getAndIncrement()
        val startedAtMs = runCatching { dependencies.clock.nowMs() }.getOrDefault(0L)
        observe(
            observationSequence = observationSequence,
            startedAtMs = startedAtMs,
            metadata = metadata,
            kind = AndroidNetworkObservationKind.REQUEST,
        )
        if (!reserveConnection()) {
            observe(
                observationSequence = observationSequence,
                startedAtMs = startedAtMs,
                metadata = metadata,
                kind = AndroidNetworkObservationKind.TERMINAL,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = "limit_exceeded",
            )
            sink.safeEmit(failure(request.id, "limit_exceeded"))
            return
        }
        val providerToken = "android-network:${nextResource.getAndIncrement()}"
        val exchange = Exchange(
            metadata = metadata,
            ownerCallToken = context.callToken,
            principal = context.principal,
            providerToken = providerToken,
            resourceSink = resourceSink,
            observationSequence = observationSequence,
            startedAtMs = startedAtMs,
        )
        val call = PendingCall(exchange, request.id, sink)
        if (calls.putIfAbsent(context.callToken, call) != null) {
            closeExchange(
                exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = "invalid_request",
            )
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        startAdmissionResolution(request, context.callToken, call)
    }

    private fun startAdmissionResolution(request: ProviderRequest, callToken: String, call: PendingCall) {
        val exchange = call.exchange
        if (!beginExchangeTask(exchange)) {
            calls.remove(callToken, call)
            cancelPending(call)
            val errorCode = if (closed.get()) "disposed" else "internal"
            closeExchange(
                exchange,
                revoke = false,
                terminalState = if (closed.get()) {
                    AndroidNetworkTerminalState.DISPOSED
                } else {
                    AndroidNetworkTerminalState.FAILED
                },
                errorCode = errorCode,
            )
            call.sink.safeEmit(failure(request.id, errorCode))
            return
        }
        val settled = AtomicBoolean(false)
        try {
            val timeout = remainingTimeout(request)
            val resolution = dependencies.addressResolver.resolve(exchange.metadata.url.host, timeout) { result ->
                if (!settled.compareAndSet(false, true)) return@resolve
                synchronized(exchange.lock) { exchange.resolution = null }
                try {
                    authorizeAdmission(callToken, call, result)
                } finally {
                    completeExchangeTask(exchange)
                }
            }
            val retained = synchronized(exchange.lock) {
                if (isRunnableCall(callToken, call, ExchangePhase.AUTHORIZING)) {
                    exchange.resolution = resolution
                    true
                } else {
                    false
                }
            }
            if (!retained) resolution.cancel()
        } catch (error: Throwable) {
            if (settled.compareAndSet(false, true)) {
                authorizeAdmission(callToken, call, Result.failure(error))
                completeExchangeTask(exchange)
            }
        }
    }

    private fun authorizeAdmission(
        callToken: String,
        call: PendingCall,
        result: Result<List<java.net.InetAddress>>,
    ) {
        val exchange = call.exchange
        if (!isRunnableCall(callToken, call, ExchangePhase.AUTHORIZING)) return
        val resolved = result.getOrElse { error ->
            when (error) {
                is NetworkResolutionCancelled -> return
                is SocketTimeoutException -> emitNetworkFailure(callToken, call, "timeout")
                else -> emitNetworkFailure(callToken, call, "unavailable")
            }
            closeExchange(
                exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = if (error is SocketTimeoutException) "timeout" else "unavailable",
            )
            return
        }
        try {
            val addresses = configuration.authorizeAddresses(exchange.metadata.url.host, resolved)
            synchronized(exchange.lock) {
                if (!call.active.get() || exchange.closed.get() || exchange.phase != ExchangePhase.AUTHORIZING) return
                exchange.resolvedAddresses = addresses
                exchange.phase = ExchangePhase.ACCEPTED
                resources[exchange.providerToken] = exchange
                require(ownerResources.putIfAbsent(exchange.ownerCallToken, exchange) == null)
            }
            val event = success(
                call.requestId,
                JSONObject().put("accepted", true),
                JSONArray().put(
                    JSONObject()
                        .put("providerToken", exchange.providerToken)
                        .put("type", NetworkV1.RESOURCE_TYPE),
                ),
            )
            if (!emitTerminal(callToken, call, event)) {
                closeExchange(
                    exchange,
                    revoke = false,
                    terminalState = AndroidNetworkTerminalState.CANCELLED,
                )
            }
        } catch (_: Throwable) {
            emitTerminal(callToken, call, failure(call.requestId, "capability_unsupported"))
            closeExchange(
                exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = "capability_unsupported",
            )
        }
    }

    private fun openBody(
        request: ProviderRequest,
        exchange: Exchange,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
    ) {
        val valid = synchronized(exchange.lock) {
            if (binary.isNotEmpty() || exchange.closed.get() || exchange.phase != ExchangePhase.ACCEPTED) false else {
                exchange.phase = ExchangePhase.UPLOADING
                true
            }
        }
        sink.safeEmit(
            if (valid) success(request.id, JSONObject().put("creditBytes", configuration.limits.maxChunkBytes))
            else failure(request.id, "invalid_request"),
        )
    }

    private fun writeBody(
        request: ProviderRequest,
        exchange: Exchange,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
    ) {
        val item = binary.singleOrNull()
        if (item == null || item.data.size > configuration.limits.maxChunkBytes) {
            sink.safeEmit(failure(request.id, if (item == null) "invalid_request" else "limit_exceeded"))
            return
        }
        val outcome = synchronized(exchange.lock) {
            if (exchange.closed.get() || exchange.phase != ExchangePhase.UPLOADING) return@synchronized "invalid_request"
            if ((exchange.metadata.method == "GET" || exchange.metadata.method == "HEAD") && item.data.isNotEmpty()) {
                return@synchronized "invalid_request"
            }
            if (item.data.size.toLong() > configuration.limits.maxRequestBodyBytes - exchange.requestBodyBytes) {
                return@synchronized "limit_exceeded"
            }
            if (exchange.requestChunks.size >= MAX_HTTP_REQUEST_CHUNKS) return@synchronized "limit_exceeded"
            exchange.requestChunks.add(item.data.copyOf())
            exchange.requestBodyBytes += item.data.size
            null
        }
        sink.safeEmit(
            if (outcome == null) {
                success(request.id, JSONObject().put("creditBytes", configuration.limits.maxChunkBytes))
            } else {
                failure(request.id, outcome)
            },
        )
    }

    private fun finishBody(
        request: ProviderRequest,
        context: ProviderContext,
        exchange: Exchange,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
    ) {
        if (binary.isNotEmpty()) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        val call = PendingCall(exchange, request.id, sink)
        if (calls.putIfAbsent(context.callToken, call) != null) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        val admitted = synchronized(exchange.lock) {
            if (exchange.closed.get() || exchange.phase != ExchangePhase.UPLOADING) false else {
                exchange.phase = ExchangePhase.EXECUTING
                true
            }
        }
        if (!admitted) {
            calls.remove(context.callToken, call)
            call.active.set(false)
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        if (!scheduleExchangeTask(exchange) { executeRequest(context.callToken, request, call) }) {
            calls.remove(context.callToken, call)
            cancelPending(call)
            val errorCode = if (closed.get()) "disposed" else "internal"
            closeExchange(
                exchange,
                revoke = false,
                terminalState = if (closed.get()) {
                    AndroidNetworkTerminalState.DISPOSED
                } else {
                    AndroidNetworkTerminalState.FAILED
                },
                errorCode = errorCode,
            )
            sink.safeEmit(failure(request.id, errorCode))
        }
    }

    private fun executeRequest(callToken: String, request: ProviderRequest, call: PendingCall) {
        val exchange = call.exchange
        var connection: NetworkHttpConnection? = null
        var requestChunks = emptyList<ByteArray>()
        try {
            if (!isRunnableCall(callToken, call, ExchangePhase.EXECUTING)) return
            reauthorizeHttpRequestMetadata(exchange.metadata, configuration)
            val address = synchronized(exchange.lock) {
                configuration.reauthorizeAddresses(exchange.metadata.url.host, exchange.resolvedAddresses)
                exchange.resolvedAddresses.first().copyOf()
            }
            if (!isRunnableCall(callToken, call, ExchangePhase.EXECUTING)) return
            val timeout = remainingTimeout(request)
            val url = exchange.metadata.url
            connection = dependencies.connectionFactory.create(
                NetworkConnectionTarget(
                    address = address,
                    host = url.host,
                    hostHeader = url.hostHeader,
                    port = url.port,
                    requestTarget = url.requestTarget,
                    scheme = url.scheme,
                ),
                timeout,
            )
            if (!attachConnection(call, connection)) return
            requestChunks = takeRequestChunks(exchange)
            if (!call.active.get()) throw CallCancelled()
            val response = connection.execute(
                NetworkTransportRequest(
                    bodyLength = exchange.requestBodyBytes,
                    chunks = requestChunks,
                    headers = exchange.metadata.headers,
                    method = exchange.metadata.method,
                ),
                configuration.limits,
            )
            observeExchange(exchange, AndroidNetworkObservationKind.TRANSPORT)
            val responseBody = response.body
            synchronized(exchange.lock) {
                if (!call.active.get() || exchange.closed.get() || exchange.phase != ExchangePhase.EXECUTING) {
                    responseBody?.close()
                    throw CallCancelled()
                }
                exchange.responseBody = responseBody
                exchange.responseStatus = response.status
                exchange.phase = ExchangePhase.RESPONSE
            }
            observeExchange(exchange, AndroidNetworkObservationKind.RESPONSE)
            val event = success(
                request.id,
                JSONObject()
                    .put("hasBody", responseBody != null)
                    .put(
                        "headers",
                        JSONArray().apply {
                            for ((name, value) in response.headers) put(JSONArray().put(name).put(value))
                        },
                    )
                    .put("status", response.status)
                    .put("statusText", response.statusText)
                    .put("url", exchange.metadata.url.raw),
            )
            if (emitTerminal(callToken, call, event)) {
                if (responseBody == null) {
                    observeTerminal(exchange, AndroidNetworkTerminalState.COMPLETED)
                }
            } else {
                closeExchange(
                    exchange,
                    revoke = false,
                    terminalState = AndroidNetworkTerminalState.CANCELLED,
                )
            }
        } catch (_: CallCancelled) {
            closeExchange(exchange, revoke = false, terminalState = AndroidNetworkTerminalState.CANCELLED)
        } catch (_: HttpResponseLimitExceeded) {
            emitTerminal(callToken, call, networkFailureResult(request.id, "network.response_too_large"))
            closeExchange(
                exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = "network.response_too_large",
            )
        } catch (_: IllegalArgumentException) {
            emitTerminal(callToken, call, failure(request.id, "capability_unsupported"))
            closeExchange(
                exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = "capability_unsupported",
            )
        } catch (error: Throwable) {
            val errorCode = networkErrorCode(error)
            emitNetworkFailure(callToken, call, errorCode)
            closeExchange(
                exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = errorCode,
            )
        } finally {
            for (chunk in requestChunks) chunk.fill(0)
        }
    }

    private fun readBody(
        request: ProviderRequest,
        context: ProviderContext,
        exchange: Exchange,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
    ) {
        if (binary.isNotEmpty()) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        val call = PendingCall(exchange, request.id, sink, stream = true)
        if (calls.putIfAbsent(context.callToken, call) != null) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        val admitted = synchronized(exchange.lock) {
            if (
                exchange.closed.get() || exchange.phase != ExchangePhase.RESPONSE ||
                exchange.responseBody == null
            ) {
                false
            } else {
                exchange.phase = ExchangePhase.READING
                true
            }
        }
        if (!admitted) {
            calls.remove(context.callToken, call)
            call.active.set(false)
            sink.safeEmit(failure(request.id, "invalid_request"))
        }
    }

    private fun scheduleDrain(callToken: String, call: PendingCall) {
        if (!call.active.get() || !call.draining.compareAndSet(false, true)) return
        if (!scheduleExchangeTask(call.exchange) { drainResponse(callToken, call) }) {
            call.draining.set(false)
            emitNetworkFailure(callToken, call, if (closed.get()) "unavailable" else "unavailable")
            closeExchange(
                call.exchange,
                revoke = false,
                terminalState = if (closed.get()) {
                    AndroidNetworkTerminalState.DISPOSED
                } else {
                    AndroidNetworkTerminalState.FAILED
                },
                errorCode = "unavailable",
            )
        }
    }

    private fun drainResponse(callToken: String, call: PendingCall) {
        try {
            if (!isRunnableCall(callToken, call, ExchangePhase.READING)) return
            while (call.active.get() && takeCredit(call)) {
                val input = synchronized(call.exchange.lock) { call.exchange.responseBody } ?: break
                val buffer = ByteArray(configuration.limits.maxChunkBytes)
                val size = input.read(buffer)
                if (!call.active.get()) return
                if (size < 0) {
                    synchronized(call.exchange.lock) {
                        runCatching { call.exchange.responseBody?.close() }
                        call.exchange.responseBody = null
                        if (call.exchange.phase == ExchangePhase.READING) call.exchange.phase = ExchangePhase.RESPONSE
                    }
                    if (emitTerminal(callToken, call, streamEnd(call.requestId))) {
                        observeTerminal(call.exchange, AndroidNetworkTerminalState.COMPLETED)
                    }
                    return
                }
                if (size == 0) throw IllegalStateException("HTTP body returned an empty read")
                val withinLimit = synchronized(call.exchange.lock) {
                    if (size.toLong() > configuration.limits.maxResponseBodyBytes - call.exchange.responseBytes) {
                        false
                    } else {
                        call.exchange.responseBytes += size
                        true
                    }
                }
                if (!withinLimit) {
                    emitTerminal(callToken, call, streamFailure(call.requestId, "network.response_too_large"))
                    closeExchange(
                        call.exchange,
                        revoke = false,
                        terminalState = AndroidNetworkTerminalState.FAILED,
                        errorCode = "network.response_too_large",
                    )
                    return
                }
                val data = if (size == buffer.size) buffer else buffer.copyOf(size)
                val sequence = call.sequence.getAndIncrement()
                synchronized(call.deliveryLock) {
                    if (!call.active.get()) return
                    call.sink.emit(streamChunk(call.requestId, sequence, data))
                }
            }
        } catch (_: HttpResponseLimitExceeded) {
            emitTerminal(callToken, call, streamFailure(call.requestId, "network.response_too_large"))
            closeExchange(
                call.exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = "network.response_too_large",
            )
        } catch (error: Throwable) {
            val errorCode = networkErrorCode(error)
            emitNetworkFailure(callToken, call, errorCode)
            closeExchange(
                call.exchange,
                revoke = false,
                terminalState = AndroidNetworkTerminalState.FAILED,
                errorCode = errorCode,
            )
        } finally {
            call.draining.set(false)
            if (call.active.get() && call.credits.get() > 0) scheduleDrain(callToken, call)
        }
    }

    private fun cancelExchange(
        request: ProviderRequest,
        exchange: Exchange,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
    ) {
        if (binary.isNotEmpty()) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        synchronized(exchange.lock) {
            if (!exchange.closed.get()) exchange.phase = ExchangePhase.CANCELLED
            runCatching { exchange.responseBody?.close() }
            exchange.responseBody = null
            exchange.connection?.close()
            exchange.connection = null
        }
        cancelCalls(exchange)
        observeTerminal(exchange, AndroidNetworkTerminalState.CANCELLED)
        sink.safeEmit(success(request.id, JSONObject().put("cancelled", true)))
    }

    private fun closeRequest(
        request: ProviderRequest,
        exchange: Exchange,
        binary: List<RuntimeNativeBinary>,
        sink: RuntimeNativeEventSink,
    ) {
        if (binary.isNotEmpty()) {
            sink.safeEmit(failure(request.id, "invalid_request"))
            return
        }
        closeExchange(exchange, revoke = false, terminalState = AndroidNetworkTerminalState.CLOSED)
        sink.safeEmit(success(request.id, JSONObject().put("closed", true)))
    }

    private fun resolveExchange(args: JSONObject, context: ProviderContext): Exchange? {
        val reference = resourceReference(args) ?: return null
        val binding = context.resources.singleOrNull() ?: return null
        if (binding.reference != reference || binding.type != NetworkV1.RESOURCE_TYPE) return null
        val exchange = resources[binding.providerToken] ?: return null
        return exchange.takeIf {
            !it.closed.get() && it.providerToken == binding.providerToken &&
                it.ownerCallToken == binding.ownerCallToken && it.principal == context.principal
        }
    }

    private fun reauthorizeExchange(exchange: Exchange): Boolean = runCatching {
        reauthorizeHttpRequestMetadata(exchange.metadata, configuration)
        synchronized(exchange.lock) {
            require(!exchange.closed.get() && exchange.phase != ExchangePhase.CLOSED)
            configuration.reauthorizeAddresses(exchange.metadata.url.host, exchange.resolvedAddresses)
            require(exchange.requestBodyBytes in 0..configuration.limits.maxRequestBodyBytes.toLong())
            require(exchange.responseBytes in 0..configuration.limits.maxResponseBodyBytes.toLong())
        }
        require(activeConnections.get() in 1..configuration.limits.maxConcurrentConnections)
    }.isSuccess

    private fun attachConnection(call: PendingCall, connection: NetworkHttpConnection): Boolean =
        synchronized(call.exchange.lock) {
            if (!call.active.get() || call.exchange.closed.get() || call.exchange.phase != ExchangePhase.EXECUTING) {
                connection.close()
                false
            } else {
                call.exchange.connection = connection
                true
            }
        }

    private fun takeRequestChunks(exchange: Exchange): List<ByteArray> = synchronized(exchange.lock) {
        val chunks = exchange.requestChunks
        exchange.requestChunks = mutableListOf()
        chunks
    }

    private fun remainingTimeout(request: ProviderRequest): Int {
        val remaining = request.deadlineMs?.let { deadline -> deadline - dependencies.clock.nowMs() }
            ?: configuration.limits.socketTimeoutMs.toLong()
        if (remaining <= 0) throw SocketTimeoutException()
        return min(remaining, configuration.limits.socketTimeoutMs.toLong()).toInt().coerceAtLeast(1)
    }

    private fun isExpired(request: ProviderRequest): Boolean = runCatching {
        request.deadlineMs != null && dependencies.clock.nowMs() >= request.deadlineMs
    }.getOrDefault(true)

    private fun reserveConnection(): Boolean {
        while (true) {
            val current = activeConnections.get()
            if (current >= configuration.limits.maxConcurrentConnections) return false
            if (activeConnections.compareAndSet(current, current + 1)) return true
        }
    }

    private fun scheduleExchangeTask(exchange: Exchange, task: () -> Unit): Boolean {
        if (!beginExchangeTask(exchange)) return false
        val accepted = runCatching {
            dependencies.worker.execute {
                try {
                    task()
                } finally {
                    completeExchangeTask(exchange)
                }
            }
        }.getOrDefault(false)
        if (!accepted) completeExchangeTask(exchange)
        return accepted
    }

    private fun beginExchangeTask(exchange: Exchange): Boolean = synchronized(exchange.lock) {
        if (closed.get() || exchange.closed.get()) return@synchronized false
        exchange.backgroundTasks.incrementAndGet()
        true
    }

    private fun completeExchangeTask(exchange: Exchange) {
        val remaining = exchange.backgroundTasks.decrementAndGet()
        check(remaining >= 0)
        if (remaining == 0 && exchange.closed.get()) releaseConnectionSlot(exchange)
    }

    private fun isRunnableCall(callToken: String, call: PendingCall, phase: ExchangePhase): Boolean {
        if (closed.get() || calls[callToken] !== call || !call.active.get()) return false
        return synchronized(call.exchange.lock) {
            !closed.get() && calls[callToken] === call && call.active.get() &&
                !call.exchange.closed.get() && call.exchange.phase == phase
        }
    }

    private fun closeExchange(
        exchange: Exchange,
        revoke: Boolean,
        terminalState: AndroidNetworkTerminalState,
        errorCode: String? = null,
    ) {
        if (!exchange.closed.compareAndSet(false, true)) return
        observeTerminal(exchange, terminalState, errorCode)
        cancelCalls(exchange)
        val resolution = synchronized(exchange.lock) {
            exchange.phase = ExchangePhase.CLOSED
            val activeResolution = exchange.resolution
            exchange.resolution = null
            for (chunk in exchange.requestChunks) chunk.fill(0)
            exchange.requestChunks.clear()
            runCatching { exchange.responseBody?.close() }
            exchange.responseBody = null
            exchange.connection?.close()
            exchange.connection = null
            activeResolution
        }
        resolution?.cancel()
        resources.remove(exchange.providerToken, exchange)
        ownerResources.remove(exchange.ownerCallToken, exchange)
        if (exchange.backgroundTasks.get() == 0) releaseConnectionSlot(exchange)
        if (revoke) {
            exchange.resourceSink.safeEmit(
                JSONObject().put("providerToken", exchange.providerToken).put("type", "revoke").toString(),
            )
        }
    }

    private fun observeTerminal(
        exchange: Exchange,
        terminalState: AndroidNetworkTerminalState,
        errorCode: String? = null,
    ) {
        if (!exchange.observationTerminal.compareAndSet(false, true)) return
        observeExchange(
            exchange = exchange,
            kind = AndroidNetworkObservationKind.TERMINAL,
            terminalState = terminalState,
            errorCode = errorCode,
        )
    }

    private fun observeExchange(
        exchange: Exchange,
        kind: AndroidNetworkObservationKind,
        terminalState: AndroidNetworkTerminalState? = null,
        errorCode: String? = null,
    ) {
        val snapshot = synchronized(exchange.lock) {
            ObservationValues(
                requestBodyBytes = exchange.requestBodyBytes,
                responseBodyBytes = exchange.responseBytes,
                statusCode = exchange.responseStatus,
            )
        }
        observe(
            observationSequence = exchange.observationSequence,
            startedAtMs = exchange.startedAtMs,
            metadata = exchange.metadata,
            kind = kind,
            requestBodyBytes = snapshot.requestBodyBytes,
            responseBodyBytes = snapshot.responseBodyBytes,
            statusCode = snapshot.statusCode,
            terminalState = terminalState,
            errorCode = errorCode,
        )
    }

    private fun observe(
        observationSequence: Long,
        startedAtMs: Long,
        metadata: HttpRequestMetadata,
        kind: AndroidNetworkObservationKind,
        requestBodyBytes: Long = 0,
        responseBodyBytes: Long = 0,
        statusCode: Int? = null,
        terminalState: AndroidNetworkTerminalState? = null,
        errorCode: String? = null,
    ) {
        runCatching {
            val elapsedMs = (dependencies.clock.nowMs() - startedAtMs).coerceAtLeast(0)
            observations.publish(
                AndroidNetworkObservation(
                    generation,
                    observationSequence,
                    kind,
                    metadata.url.origin.take(MAX_OBSERVATION_ORIGIN_CHARS),
                    metadata.method.take(MAX_OBSERVATION_METHOD_CHARS),
                    statusCode,
                    elapsedMs,
                    requestBodyBytes.coerceAtLeast(0),
                    responseBodyBytes.coerceAtLeast(0),
                    terminalState,
                    errorCode?.take(MAX_OBSERVATION_ERROR_CODE_CHARS),
                ),
            )
        }
    }

    private fun releaseConnectionSlot(exchange: Exchange) {
        if (exchange.slotReleased.compareAndSet(false, true)) activeConnections.decrementAndGet()
    }

    private fun cancelCalls(exchange: Exchange) {
        for ((token, call) in calls.entries) {
            if (call.exchange === exchange && calls.remove(token, call)) cancelPending(call)
        }
    }

    private fun cancelPending(call: PendingCall) {
        synchronized(call.deliveryLock) { call.active.set(false) }
    }

    private fun takeCredit(call: PendingCall): Boolean {
        while (true) {
            val current = call.credits.get()
            if (current <= 0) return false
            if (call.credits.compareAndSet(current, current - 1)) return true
        }
    }

    private fun emitTerminal(callToken: String, call: PendingCall, event: RuntimeNativeEvent): Boolean {
        synchronized(call.deliveryLock) {
            if (!call.active.compareAndSet(true, false)) return false
            calls.remove(callToken, call)
            return runCatching { call.sink.emit(event) }.isSuccess
        }
    }

    private fun emitNetworkFailure(callToken: String, call: PendingCall, code: String) {
        emitTerminal(callToken, call, failure(call.requestId, code, "network", "host"))
    }

    private fun networkErrorCode(error: Throwable): String = when (error) {
        is SocketTimeoutException -> "timeout"
        is ConnectException -> "connection_refused"
        is UnknownHostException -> "unavailable"
        is SSLException -> "unavailable"
        else -> "unavailable"
    }

    private class CallCancelled : IllegalStateException()

    private data class ObservationValues(
        val requestBodyBytes: Long,
        val responseBodyBytes: Long,
        val statusCode: Int?,
    )

    private companion object {
        private const val MAX_CREDITS = 1024
        private const val MAX_OBSERVATION_ERROR_CODE_CHARS = 64
        private const val MAX_OBSERVATION_METHOD_CHARS = 32
        private const val MAX_OBSERVATION_ORIGIN_CHARS = 512
    }
}

private fun RuntimeNativeEventSink.safeEmit(event: RuntimeNativeEvent) {
    runCatching { emit(event) }
}

private fun RuntimeNativeResourceEventSink.safeEmit(event: String) {
    runCatching { emit(event) }
}
