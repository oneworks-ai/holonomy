package ai.oneworks.holonomy.e2e

import ai.oneworks.holonomy.host.RuntimeOutputStream
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeSessionLimitsInstrumentationTest {
    @Test
    fun testRuntimeSessionRejectsOversizedMetadataAndOutput() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "holonomy-session-limits").apply {
            deleteRecursively()
            mkdirs()
        }
        try {
            val entryUrl = "fixture+device://phone/entry.mjs"
            val request = File(directory, "request.json").apply {
                writeText(
                    JSONObject().apply {
                        put("argv", JSONArray().apply { repeat(257) { put("") } })
                        put("entryUrl", entryUrl)
                        put("env", JSONObject())
                        put(
                            "modules",
                            JSONArray().put(
                                JSONObject().apply {
                                    put("source", "export {}")
                                    put("url", entryUrl)
                                },
                            ),
                        )
                        put("schemaVersion", 1)
                    }.toString(),
                )
            }
            assertTrue(runCatching { RuntimeSession.read(request) }.exceptionOrNull() is IllegalArgumentException)

            val output = File(directory, "output.jsonl").apply { writeText("") }
            var exitCode: Int? = null
            val host = FileRuntimeProcessHost(
                RuntimeSession(emptyList(), entryUrl, emptyMap(), null, emptyMap(), false),
                output,
            ) { code -> exitCode = code }
            host.write(RuntimeOutputStream.STDOUT, "x".repeat(1024 * 1024 + 1))
            assertEquals(1, exitCode)
            assertTrue(output.readText().contains("Holonomy runtime output limit exceeded"))
        } finally {
            directory.deleteRecursively()
        }
    }
}
