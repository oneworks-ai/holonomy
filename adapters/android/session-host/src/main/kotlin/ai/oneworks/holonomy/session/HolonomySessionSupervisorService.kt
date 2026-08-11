package ai.oneworks.holonomy.session

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process
import java.io.File
import java.security.SecureRandom

data class HolonomySessionServiceDependencies(
    val runtimeFactory: SessionRuntimeFactory,
    val nativeHostFactory: SessionNativeHostFactory,
    val supervisorLimits: SessionSupervisorLimits = SessionSupervisorLimits(),
    val commandStoreLimits: SessionCommandStoreLimits = SessionCommandStoreLimits(),
    val storedOutputLimits: StoredSessionOutputLimits = StoredSessionOutputLimits(),
)

fun interface HolonomySessionServiceProvider {
    fun createHolonomySessionServiceDependencies(): HolonomySessionServiceDependencies
}

object SessionIngressCommandIds {
    private val secureRandom = SecureRandom()
    private val ingressPattern = Regex("[a-f0-9]{32}")
    private const val HEX = "0123456789abcdef"

    fun random(): CommandId {
        val bytes = ByteArray(16).also(secureRandom::nextBytes)
        return CommandId(buildString(32) {
            bytes.forEach { byte ->
                val value = byte.toInt() and 0xff
                append(HEX[value ushr 4])
                append(HEX[value and 0x0f])
            }
        })
    }

    fun requireRandom(commandId: CommandId): CommandId = commandId.also {
        require(ingressPattern.matches(it.value)) { "Ingress commandId must be a random 128-bit hex value" }
    }
}

/** Same-application helper: journal the full command first, then send only its random ID. */
class HolonomySessionCommandIngress(
    context: Context,
    codec: SessionControlCodec = JsonSessionControlCodec(),
    limits: SessionCommandStoreLimits = SessionCommandStoreLimits(),
) {
    private val context = context.applicationContext
    private val store = AppPrivateSessionCommandStore(
        File(this.context.noBackupFilesDir, HolonomySessionSupervisorService.APP_PRIVATE_STORE_DIRECTORY),
        codec,
        limits,
    )

    fun submit(command: SessionCommandV2): Boolean {
        SessionIngressCommandIds.requireRandom(command.commandId)
        val inserted = store.putCommand(command)
        context.startForegroundService(HolonomySessionSupervisorService.commandIntent(context, command.commandId))
        return inserted
    }

    fun readReply(commandId: CommandId): SessionCommandReply? = store.readReply(commandId)
}

/**
 * Non-UI owner-process service. The application must implement HolonomySessionServiceProvider;
 * this concrete component is intentionally non-exported by the library manifest.
 */
class HolonomySessionSupervisorService : Service() {
    private lateinit var store: AppPrivateSessionCommandStore
    private lateinit var supervisor: AndroidRuntimeSessionSupervisor
    private lateinit var handler: StoredSessionCommandHandler
    private lateinit var transport: LocalAbstractSessionControlTransport
    private lateinit var endpoint: LocalAbstractSessionControlEndpoint

    override fun onCreate() {
        super.onCreate()
        startSupervisorForeground()
        val provider = application as? HolonomySessionServiceProvider
            ?: error("Application must implement HolonomySessionServiceProvider")
        val dependencies = provider.createHolonomySessionServiceDependencies()
        val codec = JsonSessionControlCodec()
        store = AppPrivateSessionCommandStore(
            root = File(noBackupFilesDir, APP_PRIVATE_STORE_DIRECTORY),
            codec = codec,
            limits = dependencies.commandStoreLimits,
        )
        supervisor = AndroidRuntimeSessionSupervisor(
            runtimeFactory = dependencies.runtimeFactory,
            nativeHostFactory = dependencies.nativeHostFactory,
            eventSink = StoredSessionSupervisorEventSink(store, dependencies.storedOutputLimits),
            limits = dependencies.supervisorLimits,
        )
        handler = StoredSessionCommandHandler(supervisor, store)
        endpoint = LocalAbstractSessionControlEndpoint(randomSocketName(packageName))
        transport = AndroidLocalAbstractSessionControlTransport(endpoint, codec)
        try {
            transport.start { command ->
                SessionIngressCommandIds.requireRandom(command.commandId)
                handler.handle(command)
            }
            store.publishControlEndpoint(
                PublishedSessionControlEndpoint(
                    protocolVersion = SESSION_CONTROL_PROTOCOL_VERSION,
                    processId = Process.myPid(),
                    socketName = endpoint.socketName,
                ),
            )
        } catch (error: Throwable) {
            runCatching { transport.close() }
            runCatching { supervisor.close() }
            throw error
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_EXECUTE_STORED_COMMAND) {
            runCatching {
                val rawCommandId = requireNotNull(intent.getStringExtra(EXTRA_COMMAND_ID))
                val commandId = SessionIngressCommandIds.requireRandom(CommandId(rawCommandId))
                val command = requireNotNull(store.readCommand(commandId)) { "Stored session command not found" }
                check(command.commandId == commandId) { "Stored session command identity mismatch" }
                handler.handle(command)
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        if (::transport.isInitialized) runCatching { transport.close() }
        if (::store.isInitialized && ::endpoint.isInitialized) {
            runCatching { store.clearControlEndpoint(endpoint.socketName) }
        }
        if (::supervisor.isInitialized) runCatching { supervisor.close() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun startSupervisorForeground() {
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                NOTIFICATION_CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = NOTIFICATION_CHANNEL_DESCRIPTION
                setShowBadge(false)
            },
        )
        val notification = Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(NOTIFICATION_TITLE)
            .setContentText(NOTIFICATION_TEXT)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setLocalOnly(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val ACTION_EXECUTE_STORED_COMMAND =
            "ai.oneworks.holonomy.session.action.EXECUTE_STORED_COMMAND"
        const val EXTRA_COMMAND_ID = "ai.oneworks.holonomy.session.extra.COMMAND_ID"
        const val APP_PRIVATE_STORE_DIRECTORY = "holonomy/session-v2"

        private const val NOTIFICATION_CHANNEL_ID = "holonomy-runtime-sessions"
        private const val NOTIFICATION_CHANNEL_NAME = "Runtime sessions"
        private const val NOTIFICATION_CHANNEL_DESCRIPTION = "Local developer runtime supervision"
        private const val NOTIFICATION_TITLE = "Holonomy runtime service"
        private const val NOTIFICATION_TEXT = "Managing local JavaScript runtime sessions"
        private const val NOTIFICATION_ID = 0x484f4c

        fun commandIntent(context: Context, commandId: CommandId): Intent {
            SessionIngressCommandIds.requireRandom(commandId)
            return Intent(context, HolonomySessionSupervisorService::class.java)
                .setAction(ACTION_EXECUTE_STORED_COMMAND)
                .putExtra(EXTRA_COMMAND_ID, commandId.value)
        }

        private fun randomSocketName(packageName: String): String {
            val suffix = SessionIngressCommandIds.random().value
            val packageHash = packageName.hashCode().toUInt().toString(16)
            return "holonomy.session.$packageHash.${Process.myPid()}.$suffix"
        }
    }
}
