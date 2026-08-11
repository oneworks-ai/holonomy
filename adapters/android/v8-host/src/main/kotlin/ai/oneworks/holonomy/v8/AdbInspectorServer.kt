package ai.oneworks.holonomy.v8

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.util.Log
import com.caoccao.javet.interop.IV8InspectorListener
import com.caoccao.javet.interop.V8Inspector
import java.io.Closeable
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal class AdbInspectorServer(
    private val inspector: V8Inspector,
    private val options: AdbInspectorOptions,
    private val sendRequest: (String) -> Unit,
    private val onMessageLoopBlocked: (Boolean) -> Unit,
    private val v8Version: String,
) : Closeable {
    private val closed = AtomicBoolean(false)
    private val pendingResponses = ConcurrentHashMap<Long, PendingResponse>()
    private val requestSequence = AtomicLong(0)
    private val runtimeSession = nextRuntimeSession.incrementAndGet()
    private val sessionLock = Any()
    private val sessions = ConcurrentHashMap<Long, InspectorSession>()
    private val sessionSequence = AtomicLong(0)
    private val connectionPool = Executors.newFixedThreadPool(MAX_CONNECTIONS) { runnable ->
        Thread(runnable, "holonomy-devtools-client").apply { isDaemon = true }
    }
    private val listener = InspectorListener()
    private val serverSocket = LocalServerSocket(options.socketName)
    private val acceptThread = Thread(::acceptConnections, "holonomy-devtools-accept").apply {
        isDaemon = true
    }

    init {
        inspector.addListeners(listener)
        acceptThread.start()
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { inspector.removeListeners(listener) }
        onMessageLoopBlocked(false)
        synchronized(sessionLock) {
            sessions.values.forEach { it.webSocket.shutdown() }
            sessions.clear()
            pendingResponses.clear()
        }
        runCatching { serverSocket.close() }
        connectionPool.shutdownNow()
        if (Thread.currentThread() !== acceptThread) runCatching { acceptThread.join(500) }
    }

    private fun acceptConnections() {
        while (!closed.get()) {
            val client = try {
                serverSocket.accept()
            } catch (_: Throwable) {
                if (!closed.get()) close()
                return
            }
            runCatching { connectionPool.execute { handleClient(client) } }
                .onFailure { runCatching { client.close() } }
        }
    }

    private fun handleClient(client: LocalSocket) {
        client.use { socket ->
            runCatching {
                socket.soTimeout = HTTP_TIMEOUT_MS
                val request = InspectorProtocol.readRequest(socket.inputStream)
                when {
                    request.path == "/json" || request.path == "/json/list" -> writeHttp(
                        socket,
                        "200 OK",
                        InspectorProtocol.discoveryList(
                            request.host,
                            options,
                            runtimeSession,
                            v8Version,
                        ),
                    )
                    request.path == "/json/version" -> writeHttp(
                        socket,
                        "200 OK",
                        InspectorProtocol.discoveryVersion(request.host, options, v8Version),
                    )
                    request.path == "/devtools/page/${options.targetId}" && request.webSocketKey != null ->
                        runWebSocket(socket, request.webSocketKey)
                    else -> writeHttp(socket, "404 Not Found", "{\"error\":\"not_found\"}")
                }
            }.onFailure {
                runCatching { writeHttp(socket, "400 Bad Request", "{\"error\":\"bad_request\"}") }
            }
        }
    }

    private fun runWebSocket(socket: LocalSocket, webSocketKey: String) {
        socket.outputStream.write(InspectorProtocol.switchingProtocols(webSocketKey))
        socket.outputStream.flush()
        socket.soTimeout = 0
        val webSocket = InspectorWebSocket(socket, options.maxMessageBytes)
        val session = InspectorSession(sessionSequence.incrementAndGet(), webSocket)
        synchronized(sessionLock) {
            if (closed.get()) {
                webSocket.shutdown()
                return
            }
            sessions[session.id] = session
        }
        try {
            webSocket.readMessages { message ->
                Log.d(LOG_TAG, "CDP inbound ${InspectorProtocol.messageSummary(message)}")
                val runtimeEnable = InspectorProtocol.commandMethod(message) == "Runtime.enable"
                val requestId = InspectorProtocol.messageId(message)
                val internalId = requestId?.let { requestSequence.incrementAndGet() }
                val admitted = synchronized(sessionLock) {
                    if (closed.get() || sessions[session.id] !== session) {
                        false
                    } else {
                        if (requestId != null && internalId != null) {
                            pendingResponses[internalId] = PendingResponse(requestId, session)
                        }
                        true
                    }
                }
                if (!admitted) return@readMessages
                if (requestId == null) {
                    sendRequest(message)
                } else {
                    sendRequest(InspectorProtocol.rewriteMessageId(message, requireNotNull(internalId)))
                }
                if (runtimeEnable && session.contextAnnounced.compareAndSet(false, true)) {
                    webSocket.sendText(InspectorProtocol.executionContextCreated(options))
                }
            }
        } finally {
            synchronized(sessionLock) {
                sessions.remove(session.id, session)
                pendingResponses.entries.removeIf { it.value.session === session }
            }
            webSocket.shutdown()
        }
    }

    private fun writeHttp(socket: LocalSocket, status: String, body: String) {
        socket.outputStream.write(
            InspectorProtocol.httpResponse(
                status = status,
                contentType = "application/json; charset=utf-8",
                body = body,
            ),
        )
        socket.outputStream.flush()
    }

    private inner class InspectorListener : IV8InspectorListener {
        override fun flushProtocolNotifications() {
            sessions.values.forEach { runCatching { it.webSocket.flush() } }
        }

        override fun receiveNotification(message: String) {
            when (InspectorProtocol.commandMethod(message)) {
                "Debugger.paused" -> onMessageLoopBlocked(true)
                "Debugger.resumed" -> onMessageLoopBlocked(false)
            }
            broadcast(message)
        }

        override fun receiveResponse(message: String) {
            val internalId = InspectorProtocol.messageId(message) ?: return
            val pending = pendingResponses.remove(internalId) ?: return
            sendTo(pending.session, InspectorProtocol.rewriteMessageId(message, pending.originalId))
        }

        override fun runIfWaitingForDebugger(contextGroupId: Int) = onMessageLoopBlocked(false)

        override fun sendRequest(message: String) = Unit

        private fun broadcast(message: String) {
            if (InspectorProtocol.isExecutionContextCreated(message)) {
                sessions.values.forEach { it.contextAnnounced.set(true) }
            }
            sessions.values.forEach { sendTo(it, message) }
        }
    }

    private data class InspectorSession(
        val id: Long,
        val webSocket: InspectorWebSocket,
        val contextAnnounced: AtomicBoolean = AtomicBoolean(false),
    )

    private data class PendingResponse(
        val originalId: Long,
        val session: InspectorSession,
    )

    private fun sendTo(session: InspectorSession, message: String) {
        if (closed.get()) return
        if (InspectorProtocol.commandMethod(message) == null) {
            Log.d(LOG_TAG, "CDP outbound ${InspectorProtocol.messageSummary(message)}")
        }
        runCatching { session.webSocket.sendText(message) }
            .onFailure {
                sessions.remove(session.id, session)
                session.webSocket.shutdown(CLOSE_TOO_LARGE)
            }
    }

    private companion object {
        private const val CLOSE_TOO_LARGE = 1009
        private const val HTTP_TIMEOUT_MS = 5_000
        private const val LOG_TAG = "HolonomyDevTools"
        private const val MAX_CONNECTIONS = 4
        private val nextRuntimeSession = AtomicLong(0)
    }
}
