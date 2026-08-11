package ai.oneworks.holonomy.e2e

import android.content.ComponentName
import android.content.Intent
import ai.oneworks.holonomy.e2e.session.supervisor.SessionSupervisorInstrumentationHarness
import ai.oneworks.holonomy.session.CancelRuntimeCommand
import ai.oneworks.holonomy.session.DisposeRuntimeCommand
import ai.oneworks.holonomy.session.HolonomySessionSupervisorService
import ai.oneworks.holonomy.session.SessionIsolation
import ai.oneworks.holonomy.session.SessionModuleSpec
import ai.oneworks.holonomy.session.SessionRuntimePhase
import ai.oneworks.holonomy.session.SessionRuntimeSpec
import ai.oneworks.holonomy.session.StartRuntimeCommand
import ai.oneworks.holonomy.session.StatusRuntimeCommand
import ai.oneworks.holonomy.session.StopRuntimeCommand
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeSessionLifecycleInstrumentationTest {
    @Test
    fun cancellationThroughExportedCommandIdIngressDisposesBlockedV8() {
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("cancel")
        try {
            val created = harness.create(runtimeId, runtimeSpec("while (true) {}"))
            assertTrue(created.ack.accepted)
            val start = StartRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 0)
            harness.submit(start)
            harness.track(runtimeId, 1)
            harness.awaitState(runtimeId, 1, "blocked runtime start") { state ->
                state.phase == SessionRuntimePhase.STARTING
            }

            val cancel = CancelRuntimeCommand(
                runtimeId,
                harness.commandId(),
                expectedGeneration = 1,
                reason = "Runtime session cancelled",
            )
            harness.stage(cancel)
            launchExportedCommandIngress(cancel.commandId.value)
            val cancelled = harness.awaitReply(cancel.commandId)

            assertTrue(cancelled.ack.accepted)
            assertEquals(SessionRuntimePhase.CANCELED, cancelled.state?.phase)
            assertEquals(124, cancelled.result?.exitCode)
            assertEquals("Runtime session cancelled", cancelled.result?.reason)
            assertTrue(harness.awaitReply(start.commandId).ack.accepted)
        } finally {
            harness.close()
        }
    }

    @Test
    fun foregroundSupervisorKeepsManagedTimersControllableAfterActivityFinishes() {
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("foreground")
        try {
            assertTrue(
                harness.create(
                    runtimeId,
                    runtimeSpec(
                        """
                            let tick = 0
                            setInterval(() => console.log('FOREGROUND_TICK:' + (++tick)), 25)
                            console.log('FOREGROUND_READY')
                        """.trimIndent(),
                    ),
                ).ack.accepted,
            )
            val start = StartRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 0)
            harness.stage(start)
            launchExportedCommandIngress(start.commandId.value)
            val started = harness.awaitReply(start.commandId)
            assertEquals(SessionRuntimePhase.RUNNING, started.state?.phase)
            harness.track(runtimeId, 1)

            InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("input keyevent KEYCODE_HOME")
                .close()
            val output = harness.awaitOutput(runtimeId, "foreground runtime timer progress") { snapshot ->
                snapshot.events.count { event -> event.chunk.contains("FOREGROUND_TICK:") } >= 2
            }
            assertTrue(output.events.any { event -> event.chunk.contains("FOREGROUND_READY") })
            assertEquals(
                SessionRuntimePhase.RUNNING,
                harness.execute(StatusRuntimeCommand(runtimeId, harness.commandId(), 1)).state?.phase,
            )

            val stopped = harness.execute(StopRuntimeCommand(runtimeId, harness.commandId(), 1))
            assertEquals(SessionRuntimePhase.STOPPED, stopped.state?.phase)
            val disposed = harness.execute(DisposeRuntimeCommand(runtimeId, harness.commandId(), 1))
            assertEquals(SessionRuntimePhase.DISPOSED, disposed.state?.phase)
            harness.forget(runtimeId)
        } finally {
            harness.close()
        }
    }

    private fun launchExportedCommandIngress(commandId: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val target = instrumentation.targetContext
        instrumentation.context.startActivity(
            Intent()
                .setComponent(ComponentName(target.packageName, HolonomyRuntimeActivity::class.java.name))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(HolonomySessionSupervisorService.EXTRA_COMMAND_ID, commandId),
        )
    }

    private fun targetContext() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun runtimeSpec(source: String) = SessionRuntimeSpec(
        entryUrl = ENTRY_URL,
        modules = listOf(SessionModuleSpec(ENTRY_URL, source)),
        isolation = SessionIsolation.LOGICAL_RUNTIME,
    )

    private companion object {
        private const val ENTRY_URL = "fixture+session://runtime/lifecycle.mjs"
    }
}
