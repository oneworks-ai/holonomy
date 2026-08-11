package ai.oneworks.holonomy.session

import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Process
import java.io.Closeable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

fun interface LocalAbstractPeerPolicy {
    fun isAllowed(uid: Int): Boolean
}

/** Allows only this application, adb shell, or an adb-root peer. */
class AdbControlledLocalPeerPolicy(
    private val applicationUid: Int = Process.myUid(),
) : LocalAbstractPeerPolicy {
    override fun isAllowed(uid: Int): Boolean = uid == applicationUid || uid == ADB_SHELL_UID || uid == ROOT_UID

    private companion object {
        private const val ADB_SHELL_UID = 2000
        private const val ROOT_UID = 0
    }
}

class AndroidLocalAbstractSessionControlTransport(
    override val endpoint: LocalAbstractSessionControlEndpoint,
    private val codec: SessionControlCodec,
    private val peerPolicy: LocalAbstractPeerPolicy = AdbControlledLocalPeerPolicy(),
    workerThreads: Int = 4,
) : LocalAbstractSessionControlTransport {
    private val lock = Any()
    private val acceptExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "holonomy-session-accept").apply { isDaemon = true }
    }
    private val workerExecutor: ExecutorService
    private val activeSockets = mutableSetOf<LocalSocket>()
    private var serverSocket: LocalServerSocket? = null
    private var closed = false

    init {
        require(workerThreads in 1..16) { "Invalid session transport worker count" }
        workerExecutor = Executors.newFixedThreadPool(workerThreads) { runnable ->
            Thread(runnable, "holonomy-session-worker").apply { isDaemon = true }
        }
    }

    override fun start(handler: SessionCommandHandler) {
        val server = synchronized(lock) {
            check(!closed) { "Session transport is closed" }
            check(serverSocket == null) { "Session transport is already started" }
            LocalServerSocket(endpoint.socketName).also { serverSocket = it }
        }
        acceptExecutor.execute { acceptLoop(server, handler) }
    }

    override fun close() {
        val (server, sockets) = synchronized(lock) {
            if (closed) return
            closed = true
            Pair(serverSocket.also { serverSocket = null }, activeSockets.toList()).also {
                activeSockets.clear()
            }
        }
        closeQuietly(server)
        sockets.forEach(::closeQuietly)
        acceptExecutor.shutdownNow()
        workerExecutor.shutdownNow()
    }

    private fun acceptLoop(server: LocalServerSocket, handler: SessionCommandHandler) {
        while (!isClosed()) {
            val socket = runCatching { server.accept() }.getOrNull() ?: break
            val admitted = synchronized(lock) {
                if (closed) false else activeSockets.add(socket)
            }
            if (!admitted) {
                closeQuietly(socket)
                break
            }
            runCatching { workerExecutor.execute { handle(socket, handler) } }
                .onFailure { closeSocket(socket) }
        }
    }

    private fun handle(socket: LocalSocket, handler: SessionCommandHandler) {
        runCatching {
            socket.soTimeout = SOCKET_TIMEOUT_MS
            check(peerPolicy.isAllowed(socket.peerCredentials.uid)) { "Session control peer is not allowed" }
            val commandBytes = LengthPrefixedSessionFrames.read(socket.inputStream, endpoint.maxMessageBytes)
            val command = codec.decodeCommand(commandBytes)
            handler.handle(command).whenComplete { reply, error ->
                try {
                    if (error == null) {
                        LengthPrefixedSessionFrames.write(
                            socket.outputStream,
                            codec.encodeReply(reply),
                            endpoint.maxMessageBytes,
                        )
                    }
                } finally {
                    closeSocket(socket)
                }
            }
        }.onFailure {
            closeSocket(socket)
        }
    }

    private fun closeSocket(socket: LocalSocket) {
        synchronized(lock) { activeSockets.remove(socket) }
        closeQuietly(socket)
    }

    private fun isClosed(): Boolean = synchronized(lock) { closed }

    private companion object {
        private const val SOCKET_TIMEOUT_MS = 30_000

        private fun closeQuietly(closeable: Closeable?) {
            runCatching { closeable?.close() }
        }
    }
}
