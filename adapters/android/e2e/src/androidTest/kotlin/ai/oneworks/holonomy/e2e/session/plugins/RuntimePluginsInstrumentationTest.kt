package ai.oneworks.holonomy.e2e.session.plugins

import ai.oneworks.holonomy.e2e.session.supervisor.SessionSupervisorInstrumentationHarness
import ai.oneworks.holonomy.session.SessionModuleSpec
import ai.oneworks.holonomy.session.SessionRuntimePluginBundle
import ai.oneworks.holonomy.session.SessionRuntimePluginFile
import ai.oneworks.holonomy.session.SessionRuntimeSpec
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimePluginsInstrumentationTest {
    @Test
    fun installsCordisPluginBeforeGuestEntry() {
        val harness = SessionSupervisorInstrumentationHarness(
            InstrumentationRegistry.getInstrumentation().targetContext,
        )
        val runtimeId = harness.runtimeId("runtime-plugin")
        try {
            val spec = SessionRuntimeSpec(
                entryUrl = ENTRY_URL,
                modules = listOf(
                    SessionModuleSpec(ENTRY_URL, "console.log('$OUTPUT_MARKER' + globalThis.pluginReady)"),
                ),
                runtimePlugins = listOf(pluginBundle()),
            )
            assertTrue(harness.create(runtimeId, spec).ack.accepted)
            assertTrue(harness.start(runtimeId).ack.accepted)
            val output = harness.awaitOutput(runtimeId, "Cordis plugin before Android entry") { snapshot ->
                snapshot.events.any { event -> event.chunk.contains("${OUTPUT_MARKER}ready") }
            }
            assertEquals(1, output.events.count { event -> event.chunk.contains(APPLY_MARKER) })
            assertEquals(1, output.events.count { event -> event.chunk.contains(OUTPUT_MARKER) })
        } finally {
            harness.close()
        }
    }

    private fun pluginBundle() = SessionRuntimePluginBundle(
        schemaVersion = 1,
        instanceId = "android-demo",
        rootUrl = "holo-plugins:///android-demo/",
        entryUrl = PLUGIN_URL,
        exportName = "default",
        configJson = "{\"value\":\"ready\"}",
        bundleSha256 = BUNDLE_SHA256,
        files = listOf(SessionRuntimePluginFile(PLUGIN_URL, PLUGIN_SOURCE, FILE_SHA256)),
    )

    private companion object {
        private const val ENTRY_URL = "app+local://workspace/runtime-plugin-entry.mjs"
        private const val PLUGIN_URL = "holo-plugins:///android-demo/index.mjs"
        private const val PLUGIN_SOURCE =
            "export default (ctx, config) => { console.log('ANDROID_PLUGIN_APPLY:' + JSON.stringify(config)); " +
                "globalThis.pluginReady = config?.value ?? 'missing' }"
        private const val FILE_SHA256 = "a2a8163fe5b67fc7c1e0db7fa88a051f1e846f9675f5f2c70b6d51a11204fac3"
        private const val BUNDLE_SHA256 = "b6dc0996cbc9bba7c0d72a31d0dac003bc85da6061b14b15caa427967d5640d3"
        private const val APPLY_MARKER = "ANDROID_PLUGIN_APPLY:"
        private const val OUTPUT_MARKER = "ANDROID_PLUGIN_ENTRY:"
    }
}
