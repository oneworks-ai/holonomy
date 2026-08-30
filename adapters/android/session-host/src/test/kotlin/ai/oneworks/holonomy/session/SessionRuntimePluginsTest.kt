package ai.oneworks.holonomy.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class SessionRuntimePluginsTest {
    @Test
    fun `plugin bundles round trip and resolve only from the runtime or their own graph`() {
        val bundle = pluginBundle()
        val spec = SessionRuntimeSpec(
            entryUrl = ENTRY,
            modules = listOf(SessionModuleSpec(ENTRY, "export {}")),
            runtimePlugins = listOf(bundle),
        )
        val command = CreateRuntimeCommand(RuntimeId("runtime"), CommandId("create"), spec)
        val decoded = JsonSessionControlCodec().decodeCommand(JsonSessionControlCodec().encodeCommand(command))
            as CreateRuntimeCommand
        assertEquals(listOf(bundle), decoded.spec.runtimePlugins)

        val graph = SessionRuntimePluginGraph(decoded.spec.runtimePlugins)
        val identity = "$PLUGIN_URL?holo-bundle=$BUNDLE_SHA256"
        val manifest = graph.resolve(RUNTIME_PLUGIN_MANIFEST_URL, "holonomy:///runtime/bootstrap.mjs")
        requireNotNull(manifest)
        assertEquals(PLUGIN_SOURCE, graph.resolve(PLUGIN_URL, manifest.resourceUrl)?.source)
        assertEquals(PLUGIN_SOURCE, graph.resolve(identity, "holonomy:///runtime/bootstrap.mjs")?.source)
        assertNull(graph.resolve(identity, ENTRY))
        assertNull(graph.resolve("../outside.mjs", identity))

        val sessionGraph = SessionModuleGraph(decoded.spec)
        assertNull(sessionGraph.resolver.resolve(ENTRY, identity))
        assertNull(sessionGraph.resolver.resolve(identity, ENTRY))
    }

    @Test
    fun `plugin bundle digest and file digest fail closed`() {
        assertThrows(IllegalArgumentException::class.java) {
            pluginBundle(bundleSha256 = "0".repeat(64))
        }
        assertThrows(IllegalArgumentException::class.java) {
            pluginBundle(fileSha256 = "0".repeat(64))
        }
        assertThrows(IllegalArgumentException::class.java) {
            SessionRuntimePluginFile(PLUGIN_URL, "\uD800", "0".repeat(64))
        }
    }

    private fun pluginBundle(
        bundleSha256: String = BUNDLE_SHA256,
        fileSha256: String = FILE_SHA256,
    ) = SessionRuntimePluginBundle(
        schemaVersion = 1,
        instanceId = "demo",
        rootUrl = "holo-plugins:///demo/",
        entryUrl = PLUGIN_URL,
        exportName = "default",
        configJson = "{\"name\":\"android\"}",
        bundleSha256 = bundleSha256,
        files = listOf(SessionRuntimePluginFile(PLUGIN_URL, PLUGIN_SOURCE, fileSha256)),
    )

    private companion object {
        private const val ENTRY = "app+local://workspace/entry.mjs"
        private const val PLUGIN_URL = "holo-plugins:///demo/index.mjs"
        private const val PLUGIN_SOURCE =
            "import { Context } from 'cordis'; export default function plugin(ctx) { ctx.on('ready', () => {}) }"
        private const val FILE_SHA256 = "11e2491e6c05609d3d2ce231353dbca32dcf86daccb14891f69feaeff0102a76"
        private const val BUNDLE_SHA256 = "268c2647dd2849809fc1507d9eb59add8fe37847f82cdf7884b2f6dd64d3dd87"
    }
}
