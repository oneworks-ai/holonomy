package ai.oneworks.holonomy.capability

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.PowerManager
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONArray
import org.json.JSONObject

/** Trusted Host source for normalized raw Android Device values. */
fun interface AndroidDeviceValueSource {
    fun value(operation: String): Any

    companion object {
        /** Creates the production Android platform value source. */
        @JvmStatic
        fun platform(context: Context): AndroidDeviceValueSource = AndroidPlatformDeviceValueSource(context)
    }
}

private class AndroidPlatformDeviceValueSource(context: Context) : AndroidDeviceValueSource {
    private val context = context.applicationContext

    override fun value(operation: String): Any = when (operation) {
        "device.connectivity.cellular.state.read" -> cellular()
        "device.connectivity.read" -> connectivity()
        "device.connectivity.wifi.state.read" -> wifi()
        "device.display.read" -> display()
        "device.form-factor.read" -> formFactor()
        "device.input.read" -> input()
        "device.lifecycle.read" -> lifecycle()
        "device.power.read" -> power()
        else -> throw ProviderFailure("provider.unavailable")
    }

    private fun formFactor(): String = when {
        context.resources.configuration.smallestScreenWidthDp >= 600 -> "tablet"
        else -> "phone"
    }

    private fun connectivity(): JSONObject {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager?.activeNetwork?.let(manager::getNetworkCapabilities)
        val transports = JSONArray()
        if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) transports.put("wifi")
        if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true) transports.put("cellular")
        if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true) transports.put("ethernet")
        if (capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true) transports.put("vpn")
        val online = capabilities != null
        val validated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        return JSONObject()
            .put("captivePortal", capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL) ?: "unknown")
            .put("metered", manager?.isActiveNetworkMetered ?: "unknown")
            .put("online", online)
            .put("quality", if (!online) "offline" else if (validated) "good" else "unknown")
            .put("roaming", "unknown")
            .put("transports", transports)
            .put("validated", validated)
    }

    private fun wifi(): JSONObject {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager?.activeNetwork?.let(manager::getNetworkCapabilities)
        return JSONObject().put("connected", capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true)
    }

    private fun cellular(): JSONObject {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager?.activeNetwork?.let(manager::getNetworkCapabilities)
        return JSONObject()
            .put("connected", capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
            .put("radio", "unknown")
    }

    private fun display(): JSONObject {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        context.getSystemService(WindowManager::class.java)?.defaultDisplay?.getRealMetrics(metrics)
        val density = if (metrics.density > 0) metrics.density.toDouble() else 1.0
        val configuration = context.resources.configuration
        return JSONObject()
            .put("hdr", "unknown")
            .put("heightCssPx", (metrics.heightPixels / density).toInt().coerceAtLeast(1))
            .put(
                "orientation",
                when (configuration.orientation) {
                    Configuration.ORIENTATION_LANDSCAPE -> "landscape"
                    Configuration.ORIENTATION_PORTRAIT -> "portrait"
                    else -> "unknown"
                },
            )
            .put("scale", density.coerceIn(0.25, 16.0))
            .put("wideColor", "unknown")
            .put("widthCssPx", (metrics.widthPixels / density).toInt().coerceAtLeast(1))
    }

    private fun input(): JSONObject {
        val manager = context.getSystemService(InputManager::class.java)
        val sources = mutableListOf<Int>()
        for (deviceId in manager?.inputDeviceIds ?: IntArray(0)) {
            manager?.getInputDevice(deviceId)?.let { device -> sources += device.sources }
        }
        val configuration = context.resources.configuration
        val touch = configuration.touchscreen != Configuration.TOUCHSCREEN_NOTOUCH
        val keyboard = configuration.keyboard != Configuration.KEYBOARD_NOKEYS
        val mouse = sources.any { source -> (source and android.view.InputDevice.SOURCE_MOUSE) != 0 }
        return JSONObject()
            .put("hover", mouse)
            .put("keyboard", keyboard)
            .put("maxTouchPoints", if (touch) 10 else 0)
            .put("mouse", mouse)
            .put("pointer", if (mouse) "fine" else if (touch) "coarse" else "none")
            .put("touch", touch)
    }

    private fun lifecycle(): JSONObject {
        val manager = context.getSystemService(ActivityManager::class.java)
        val memory = ActivityManager.MemoryInfo().also { manager?.getMemoryInfo(it) }
        val power = context.getSystemService(PowerManager::class.java)
        return JSONObject()
            .put("interactive", power?.isInteractive ?: "unknown")
            .put("memoryPressure", if (memory.lowMemory) "critical" else "normal")
            .put("visibility", "foreground")
    }

    private fun power(): JSONObject {
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
            ?: BatteryManager.BATTERY_STATUS_UNKNOWN
        val hasBattery = level >= 0 && scale > 0
        val charging = hasBattery && status in setOf(BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL)
        val source = when (plugged) {
            BatteryManager.BATTERY_PLUGGED_AC -> "ac"
            BatteryManager.BATTERY_PLUGGED_USB -> "usb"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            else -> if (hasBattery) "battery" else "unknown"
        }
        return JSONObject()
            .put("charging", if (hasBattery) charging else false)
            .put("hasBattery", hasBattery)
            .put("lowPowerMode", context.getSystemService(PowerManager::class.java)?.isPowerSaveMode ?: "unknown")
            .put("source", source)
            .apply { if (hasBattery) put("levelPercent", (level * 100 / scale).coerceIn(0, 100)) }
    }
}
