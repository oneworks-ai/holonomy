package ai.oneworks.holonomy.e2e

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import ai.oneworks.holonomy.session.CommandId
import ai.oneworks.holonomy.session.HolonomySessionSupervisorService
import ai.oneworks.holonomy.session.SessionIngressCommandIds

/** Exported compatibility ingress: the full v2 command must already exist in app-private storage. */
class HolonomyRuntimeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        forwardStoredCommand(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        forwardStoredCommand(intent)
    }

    private fun forwardStoredCommand(intent: Intent) {
        val commandId = intent.getStringExtra(HolonomySessionSupervisorService.EXTRA_COMMAND_ID)
            ?.let { raw -> runCatching { SessionIngressCommandIds.requireRandom(CommandId(raw)) }.getOrNull() }
        if (commandId != null) {
            startForegroundService(HolonomySessionSupervisorService.commandIntent(this, commandId))
        }
        finish()
    }
}
