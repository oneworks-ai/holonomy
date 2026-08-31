package ai.oneworks.holonomy.capability

import android.content.BroadcastReceiver
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicBoolean

/** Trusted Host observation source used by the Android Device Provider. */
fun interface AndroidDeviceObservationSource {
    fun subscribe(kinds: Set<String>, listener: (String) -> Unit): AutoCloseable

    companion object {
        /** Creates the production Android platform observation source. */
        @JvmStatic
        fun platform(context: Context): AndroidDeviceObservationSource =
            AndroidPlatformDeviceObservationSource(context)
    }
}

internal class AndroidPlatformDeviceObservationSource(
    context: Context,
) : AndroidDeviceObservationSource {
    private val context = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun subscribe(kinds: Set<String>, listener: (String) -> Unit): AutoCloseable {
        val closers = mutableListOf<() -> Unit>()
        if ("connectivity" in kinds) registerConnectivity(listener, closers)
        if ("display" in kinds) registerDisplay(listener, closers)
        if ("power" in kinds || "lifecycle" in kinds) registerBroadcasts(kinds, listener, closers)
        if ("display" in kinds || "lifecycle" in kinds) registerComponents(kinds, listener, closers)
        val closed = AtomicBoolean(false)
        return AutoCloseable {
            if (!closed.compareAndSet(false, true)) return@AutoCloseable
            closers.asReversed().forEach { close -> runCatching(close) }
        }
    }

    private fun registerConnectivity(listener: (String) -> Unit, closers: MutableList<() -> Unit>) {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = listener("connectivity")
            override fun onLost(network: Network) = listener("connectivity")
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
                listener("connectivity")
        }
        manager.registerDefaultNetworkCallback(callback, mainHandler)
        closers += { manager.unregisterNetworkCallback(callback) }
    }

    private fun registerDisplay(listener: (String) -> Unit, closers: MutableList<() -> Unit>) {
        val manager = context.getSystemService(DisplayManager::class.java) ?: return
        val callback = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = listener("display")
            override fun onDisplayChanged(displayId: Int) = listener("display")
            override fun onDisplayRemoved(displayId: Int) = listener("display")
        }
        manager.registerDisplayListener(callback, mainHandler)
        closers += { manager.unregisterDisplayListener(callback) }
    }

    @Suppress("DEPRECATION")
    private fun registerBroadcasts(
        kinds: Set<String>,
        listener: (String) -> Unit,
        closers: MutableList<() -> Unit>,
    ) {
        var lastBatteryFingerprint = if ("power" in kinds) currentBatteryFingerprint() else null
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_BATTERY_CHANGED -> if ("power" in kinds) {
                        val next = batteryFingerprint(intent)
                        if (next != lastBatteryFingerprint) {
                            lastBatteryFingerprint = next
                            listener("power")
                        }
                    }
                    Intent.ACTION_POWER_CONNECTED,
                    Intent.ACTION_POWER_DISCONNECTED,
                    -> if ("power" in kinds) listener("power")
                    Intent.ACTION_SCREEN_OFF,
                    Intent.ACTION_SCREEN_ON,
                    -> if ("lifecycle" in kinds) listener("lifecycle")
                }
            }
        }
        val filter = IntentFilter().apply {
            if ("power" in kinds) {
                addAction(Intent.ACTION_BATTERY_CHANGED)
                addAction(Intent.ACTION_POWER_CONNECTED)
                addAction(Intent.ACTION_POWER_DISCONNECTED)
            }
            if ("lifecycle" in kinds) {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
            }
        }
        context.registerReceiver(receiver, filter)
        closers += { context.unregisterReceiver(receiver) }
    }

    private fun currentBatteryFingerprint(): String? = context
        .registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        ?.let(::batteryFingerprint)

    private fun batteryFingerprint(intent: Intent): String = listOf(
        BatteryManager.EXTRA_LEVEL,
        BatteryManager.EXTRA_SCALE,
        BatteryManager.EXTRA_PLUGGED,
        BatteryManager.EXTRA_STATUS,
    ).joinToString(separator = ":") { name -> intent.getIntExtra(name, -1).toString() }

    private fun registerComponents(
        kinds: Set<String>,
        listener: (String) -> Unit,
        closers: MutableList<() -> Unit>,
    ) {
        val callback = object : ComponentCallbacks2 {
            override fun onConfigurationChanged(configuration: Configuration) {
                if ("display" in kinds) listener("display")
                if ("lifecycle" in kinds) listener("lifecycle")
            }

            override fun onLowMemory() {
                if ("lifecycle" in kinds) listener("lifecycle")
            }

            override fun onTrimMemory(level: Int) {
                if ("lifecycle" in kinds) listener("lifecycle")
            }
        }
        context.registerComponentCallbacks(callback)
        closers += { context.unregisterComponentCallbacks(callback) }
    }
}
