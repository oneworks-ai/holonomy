package ai.oneworks.holonomy.e2e.session.capability

import ai.oneworks.holonomy.e2e.session.supervisor.SessionSupervisorInstrumentationHarness
import ai.oneworks.holonomy.e2e.E2eTrustedBackendEvidence
import ai.oneworks.holonomy.session.RuntimeId
import ai.oneworks.holonomy.session.SessionControlOperation
import ai.oneworks.holonomy.session.SessionIsolation
import ai.oneworks.holonomy.session.SessionModuleSpec
import ai.oneworks.holonomy.session.SessionOutputEvent
import ai.oneworks.holonomy.session.SessionRuntimePhase
import ai.oneworks.holonomy.session.SessionRuntimeSpec
import ai.oneworks.holonomy.session.StatusRuntimeCommand
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.session.SessionSandboxNetworkPolicy
import ai.oneworks.holonomy.session.SessionSandboxPolicy
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CapabilityRuntimeKernelInstrumentationTest {
    @Test
    fun serviceCompiledSnapshotRunsControlledAndroidCapabilitySliceAndRestart() {
        val fixture = fixture()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("capability-kernel")
        val expectsV86 = targetContext().assets.list(V86_ROOT).orEmpty().contains("v86.wasm")
        try {
            val created = harness.create(runtimeId, runtimeSpec(fixture, runtimeId))
            assertTrue(created.ack.accepted)
            assertEquals(SessionRuntimePhase.CREATED, created.state?.phase)
            val started = harness.start(runtimeId)
            assertTrue(started.ack.accepted)
            if (started.state?.phase != SessionRuntimePhase.RUNNING) {
                val status = harness.execute(StatusRuntimeCommand(runtimeId, harness.commandId(), 1))
                val evidence = status.output?.events.orEmpty().joinToString(separator = "") { it.chunk }
                assertEquals("output=$evidence result=${status.result}", SessionRuntimePhase.RUNNING, status.state?.phase)
            }
            val first = awaitResult(harness, runtimeId, 1)
            assertKernelResult(first)
            assertTrustedBackendStarted(
                E2eTrustedBackendEvidence.awaitStarted(runtimeId.value, 1, if (expectsV86) 6 else 2),
                expectsV86,
            )
            assertFalse(first.toString().contains("android-private-tenant"))
            assertFalse(first.toString().contains("Android Capability Inspector"))

            val restarted = harness.execute(
                ai.oneworks.holonomy.session.RestartRuntimeCommand(
                    runtimeId,
                    harness.commandId(),
                    expectedGeneration = 1,
                ),
            )
            assertTrue(restarted.ack.accepted)
            assertEquals(2L, restarted.ack.generation)
            harness.track(runtimeId, 2)
            assertKernelResult(awaitResult(harness, runtimeId, 2))
            assertEquals(
                "runtime.generation_stale",
                E2eTrustedBackendEvidence.awaitClosed(runtimeId.value, 1).getJSONObject("error").getString("code"),
            )
            assertTrustedBackendStarted(
                E2eTrustedBackendEvidence.awaitStarted(runtimeId.value, 2, if (expectsV86) 6 else 2),
                expectsV86,
            )
        } finally {
            harness.close()
        }
    }

    @Test
    fun invalidInitialHostBindingFailsBeforeGuestEntry() {
        val fixture = fixture()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("capability-invalid")
        try {
            val capabilityRuntime = fixture.getJSONObject("capabilityRuntime")
            capabilityRuntime.put("processId", runtimeId.value)
            capabilityRuntime.getJSONObject("runtimeCreation")
                .getJSONObject("hostBindings")
                .getJSONObject("engineGate")
                .put("ownerId", "wrong-owner")
            assertTrue(harness.create(runtimeId, runtimeSpec(fixture, runtimeId)).ack.accepted)
            val started = harness.start(runtimeId)
            assertEquals(SessionRuntimePhase.FAILED, started.state?.phase)
            assertFalse(started.output?.events.orEmpty().any { it.chunk.contains(OUTPUT_MARKER) })
        } finally {
            harness.close()
        }
    }

    private fun assertKernelResult(result: JSONObject) {
        assertTrue(result.getString("arch") in setOf("arm64", "x64"))
        assertEquals("android-guest-input", result.getString("callbackValue"))
        assertEquals("android-guest-input", result.getString("promiseValue"))
        assertEquals("android-guest-input", result.getString("syncValue"))
        assertEquals(1, result.getInt("writeCallbackArity"))
        assertEquals("mock-capability", result.getString("mockBody"))
        assertEquals("android.capability.fixture", result.getJSONObject("context")
            .getJSONObject("application").getString("id"))
        assertTrue(result.getJSONObject("device").getString("value") in setOf("phone", "tablet"))
        assertEquals("available", result.getJSONObject("power").getString("status"))
        val linuxFilesystem = result.getJSONObject("linuxFilesystem")
        assertFalse("linux filesystem bridge failed: $linuxFilesystem", linuxFilesystem.has("error"))
        assertEquals("android-guest-input", linuxFilesystem.getString("input"))
        assertEquals("android-linux-output", linuxFilesystem.getString("output"))
        assertEquals(19, linuxFilesystem.getInt("size"))
        assertEquals(41, linuxFilesystem.getInt("linuxPid"))
        assertEquals(9, linuxFilesystem.getInt("syntheticProcessId"))
        assertEquals(20, linuxFilesystem.getInt("written"))
        val codeGeneration = result.getJSONObject("codeGeneration")
        assertTrue(codeGeneration.getBoolean("evalBlocked"))
        assertTrue(codeGeneration.getBoolean("functionBlocked"))
        assertTrue(codeGeneration.getBoolean("wasmUnavailable"))
    }

    private fun assertTrustedBackendStarted(terminal: JSONObject, expectsV86: Boolean) {
        assertTrue("trusted Backend failed: $terminal", terminal.getBoolean("ok"))
        val result = terminal.getJSONObject("result")
        assertEquals("value", result.getString("kind"))
        val value = result.getJSONObject("value")
        if (!expectsV86) {
            assertEquals("file", value.getString("kind"))
            assertTrue(value.getString("handle").startsWith("fd-"))
            return
        }
        assertEquals("v86", value.getString("backend"))
        assertEquals("v86 evidence=$value", 0, value.getInt("code"))
        assertEquals("FUSE_INPUT:android-guest-input", value.getString("stdout"))
        assertEquals("GUEST_TO_HOST", value.getString("output"))
        assertTrue(value.getInt("fuseEvents") >= 6)
        assertTrue(value.getInt("linuxPid") > 0)
        val network = value.getJSONObject("network")
        assertTrue(network.getBoolean("authorized"))
        assertTrue(network.getInt("linuxPid") > 0)
        assertTrue(network.getString("stdout").startsWith("HTTP/1.1 200 OK"))
        assertTrue(network.getString("stdout").contains("HOLO_ANDROID_V86_NETWORK_OK"))
        assertTrue(value.getInt("processId") > 0)
        assertEquals(value.getInt("linuxPid"), value.getInt("writeLinuxPid"))
    }

    private fun awaitResult(
        harness: SessionSupervisorInstrumentationHarness,
        runtimeId: RuntimeId,
        generation: Long,
    ): JSONObject {
        val output = runCatching {
            harness.awaitOutput(runtimeId, "M2.5 Android capability output") { snapshot ->
            snapshot.events.any { event ->
                event.generation == generation && event.chunk.contains(OUTPUT_MARKER)
            }
            }
        }.getOrElse { error ->
            val status = harness.execute(StatusRuntimeCommand(runtimeId, harness.commandId(), generation))
            throw AssertionError("${error.message}; state=${status.state}; result=${status.result}; output=${status.output}", error)
        }
        val chunk = output.events.first { event: SessionOutputEvent ->
            event.generation == generation && event.chunk.contains(OUTPUT_MARKER)
        }.chunk
        return JSONObject(chunk.substringAfter(OUTPUT_MARKER).trim())
    }

    private fun fixture(): JSONObject = targetContext().assets.open(FIXTURE_ASSET)
        .bufferedReader()
        .use { JSONObject(it.readText()) }

    private fun runtimeSpec(fixture: JSONObject, runtimeId: RuntimeId): SessionRuntimeSpec {
        val capabilityRuntime = fixture.getJSONObject("capabilityRuntime").put("processId", runtimeId.value)
        val entryUrl = fixture.getString("entryUrl")
        return SessionRuntimeSpec(
            entryUrl = entryUrl,
            modules = listOf(SessionModuleSpec(entryUrl, fixture.getString("source"))),
            isolation = SessionIsolation.LOGICAL_RUNTIME,
            initialControls = listOf(
                SessionControlOperation(NETWORK_RULES_REPLACE, networkRules().toString()),
            ),
            sandboxPolicy = SessionSandboxPolicy(
                network = SessionSandboxNetworkPolicy(
                    access = SessionSandboxNetworkAccess.MOCK_ONLY,
                    allowedOrigins = setOf(MOCK_ORIGIN),
                    allowedSchemes = setOf("https"),
                    allowPrivateNetwork = false,
                ),
            ),
            capabilityRuntimeJson = capabilityRuntime.toString(),
        )
    }

    private fun networkRules() = JSONObject()
        .put("mode", "failClosed")
        .put(
            "rules",
            JSONArray().put(
                JSONObject()
                    .put("id", "capability-profile")
                    .put("priority", 100)
                    .put(
                        "match",
                        JSONObject()
                            .put("method", "GET")
                            .put("origin", MOCK_ORIGIN)
                            .put("path", JSONObject().put("op", "exact").put("value", "/profile"))
                            .put(
                                "query",
                                JSONObject()
                                    .put("mode", "subset")
                                    .put("entries", JSONArray()),
                            ),
                    )
                    .put(
                        "action",
                        JSONObject()
                            .put("type", "respond")
                            .put("status", 200)
                            .put(
                                "headers",
                                JSONArray().put(JSONArray().put("content-type").put("text/plain")),
                            )
                            .put("body", JSONObject().put("kind", "utf8").put("value", "mock-capability")),
                    ),
            ),
        )

    private fun targetContext() = InstrumentationRegistry.getInstrumentation().targetContext

    private companion object {
        private const val FIXTURE_ASSET = "runtime/capability-kernel-v1.json"
        private const val MOCK_ORIGIN = "https://mock.example"
        private const val NETWORK_RULES_REPLACE = "network.rules.replace"
        private const val OUTPUT_MARKER = "M25_ANDROID:"
        private const val V86_ROOT = "runtime/process-backends/v86"
    }
}
