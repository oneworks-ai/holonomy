package ai.oneworks.holonomy.v8

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class EmptyRuntimePluginManifestTest {
    @Test
    fun `empty configured graph has one internal fallback but no plugin code fallback`() {
        assertNotNull(emptyRuntimePluginManifest("holo-plugins:///manifest.mjs", true, "[ ]"))
        assertNull(emptyRuntimePluginManifest("holo-plugins:///manifest.mjs", false, "[]"))
        assertNull(emptyRuntimePluginManifest("holo-plugins:///plugin.mjs", true, "[]"))
        assertNull(emptyRuntimePluginManifest("holo-plugins:///manifest.mjs", true, "[{\"id\":\"required\"}]"))
    }
}
