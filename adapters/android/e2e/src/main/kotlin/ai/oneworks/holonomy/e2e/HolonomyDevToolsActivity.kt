package ai.oneworks.holonomy.e2e

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.ScrollView
import android.widget.TextView
import ai.oneworks.holonomy.host.RuntimeEngine
import ai.oneworks.holonomy.v8.AdbInspectorOptions
import ai.oneworks.holonomy.v8.RuntimeEngineFactory

class HolonomyDevToolsActivity : Activity() {
    private var engine: RuntimeEngine? = null
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply {
            gravity = Gravity.START
            setPadding(PADDING, PADDING, PADDING, PADDING)
            textSize = 16f
            typeface = Typeface.MONOSPACE
        }
        setContentView(ScrollView(this).apply { addView(status) })

        val socketName = intent.getStringExtra(EXTRA_SOCKET_NAME) ?: AdbInspectorOptions.DEFAULT_SOCKET_NAME
        val waitForDebugger = intent.getBooleanExtra(EXTRA_WAIT_FOR_DEBUGGER, false)
        showStatus(socketName, waitForDebugger, "starting")
        val createdEngine = RuntimeEngineFactory.create(
            assets = assets,
            nativeHostFactory = ::createE2eRuntimeNativeHost,
            inspectorOptions = AdbInspectorOptions(
                socketName = socketName,
                waitForDebugger = waitForDebugger,
            ),
        )
        engine = createdEngine
        createdEngine.start().whenComplete { _, error ->
            runOnUiThread {
                if (error == null) {
                    showStatus(socketName, waitForDebugger, "ready")
                    Log.i(LOG_TAG, "ready socket=$socketName inspector=true")
                } else {
                    showStatus(socketName, waitForDebugger, "failed")
                    Log.e(LOG_TAG, "runtime startup failed")
                }
            }
        }
    }

    override fun onDestroy() {
        val currentEngine = engine
        engine = null
        currentEngine?.dispose()?.whenComplete { _, _ ->
            Log.i(LOG_TAG, "disposed")
        }
        super.onDestroy()
    }

    private fun showStatus(socketName: String, waitForDebugger: Boolean, phase: String) {
        status.text = """
            Holonomy V8 DevTools

            phase: $phase
            inspector: enabled
            transport: adb local-abstract socket
            socket: $socketName
            wait for debugger: $waitForDebugger

            Desktop:
            pnpm android:devtools start --open

            The CLI installs this debug host, allocates an
            available desktop port with adb forward, and opens
            Chrome DevTools against this exact V8 isolate.
        """.trimIndent()
    }

    companion object {
        const val EXTRA_SOCKET_NAME = "holonomy.inspector.socket"
        const val EXTRA_WAIT_FOR_DEBUGGER = "holonomy.inspector.wait"

        private const val LOG_TAG = "HolonomyDevTools"
        private const val PADDING = 48
    }
}
