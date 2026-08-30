package ai.oneworks.holonomy.e2e.session.supervisor

import android.os.SystemClock
import android.util.Base64
import ai.oneworks.holonomy.session.ControlRuntimeCommand
import ai.oneworks.holonomy.session.DisposeRuntimeCommand
import ai.oneworks.holonomy.session.RestartRuntimeCommand
import ai.oneworks.holonomy.session.SessionControlErrorCode
import ai.oneworks.holonomy.session.SessionControlOperation
import ai.oneworks.holonomy.session.SessionIsolation
import ai.oneworks.holonomy.session.SessionModuleSpec
import ai.oneworks.holonomy.session.SessionOutputEvent
import ai.oneworks.holonomy.session.SessionOutputStream
import ai.oneworks.holonomy.session.SessionRuntimePhase
import ai.oneworks.holonomy.session.SessionRuntimeSpec
import ai.oneworks.holonomy.session.SessionSandboxFilesystemAccess
import ai.oneworks.holonomy.session.SessionSandboxFilesystemPolicy
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.session.SessionSandboxNetworkPolicy
import ai.oneworks.holonomy.session.SessionSandboxPolicy
import ai.oneworks.holonomy.session.StartRuntimeCommand
import ai.oneworks.holonomy.session.StatusRuntimeCommand
import ai.oneworks.holonomy.session.StopRuntimeCommand
import ai.oneworks.holonomy.e2e.E2eNativeHostDiagnostics
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.TimeUnit
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionSupervisorInstrumentationTest {
    @Test
    fun capabilityNetworkRestrictedRealRequestUsesTheProductionTransport() {
        val server = ServerSocket(REAL_NETWORK_PORT, 1, InetAddress.getByName("127.0.0.1"))
        val serverThread = thread(name = "holonomy-real-network-e2e") {
            server.use { socket ->
                socket.accept().use { client ->
                    val input = client.getInputStream().bufferedReader()
                    while (!input.readLine().isNullOrEmpty()) Unit
                    val body = "android-real-transport"
                    client.getOutputStream().bufferedWriter().use { output ->
                        output.write("HTTP/1.1 200 OK\r\n")
                        output.write("Content-Type: text/plain\r\n")
                        output.write("Content-Length: ${body.toByteArray().size}\r\n")
                        output.write("Connection: close\r\n\r\n")
                        output.write(body)
                    }
                }
            }
        }
        val fixture = capabilityNetworkFixture(CAPABILITY_NETWORK_REAL_FIXTURE_ASSET)
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("network-real")
        try {
            assertTrue(harness.create(
                runtimeId,
                capabilityNetworkRuntimeSpec(
                    fixture,
                    runtimeId,
                    initialControls = emptyList(),
                    sandboxPolicy = realRestrictedPolicy(),
                ),
            ).ack.accepted)
            assertTrue(harness.start(runtimeId).ack.accepted)
            val output = harness.awaitOutput(runtimeId, "real capability network transport") { snapshot ->
                snapshot.events.any { event -> event.chunk.contains(CAPABILITY_NETWORK_REAL_OUTPUT_MARKER) } &&
                    networkDiagnostics(snapshot.events, 1L).any { event ->
                        event.optString("type") == "responseReceived" && event.optString("source") == "real"
                    }
            }
            val result = JSONObject(output.events.first { event ->
                event.chunk.contains(CAPABILITY_NETWORK_REAL_OUTPUT_MARKER)
            }.chunk.substringAfter(CAPABILITY_NETWORK_REAL_OUTPUT_MARKER).trim())
            assertEquals(200, result.getInt("status"))
            assertEquals("android-real-transport", result.getString("body"))
        } finally {
            harness.close()
            runCatching { server.close() }
            serverThread.join(TimeUnit.SECONDS.toMillis(5))
            assertFalse("Real network fixture server did not terminate", serverThread.isAlive)
        }
    }

    @Test
    fun capabilityNetworkRedirectCloneBodyAndCancellationUseBrokerContinuations() {
        val fixture = capabilityNetworkFixture()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("network-continuations")
        try {
            val created = harness.create(
                runtimeId,
                capabilityNetworkRuntimeSpec(fixture, runtimeId),
            )
            assertTrue(created.ack.accepted)
            assertTrue(harness.start(runtimeId).ack.accepted)
            val output = harness.awaitOutput(runtimeId, "capability network continuations") { snapshot ->
                snapshot.events.any { event -> event.chunk.contains(CAPABILITY_NETWORK_OUTPUT_MARKER) } &&
                    networkDiagnostics(snapshot.events, 1L).any { event ->
                        event.optString("type") == "responseReceived" &&
                            event.optString("source") == "mock" &&
                            event.optString("url") == "$MOCK_ORIGIN/redirected"
                    } &&
                    networkDiagnostics(snapshot.events, 1L).any { event ->
                        event.optString("type") == "loadingFailed" &&
                            event.optString("code") == "network.cancelled"
                    }
            }
            val result = JSONObject(
                output.events.first { event -> event.chunk.contains(CAPABILITY_NETWORK_OUTPUT_MARKER) }
                    .chunk.substringAfter(CAPABILITY_NETWORK_OUTPUT_MARKER).trim(),
            )
            assertEquals("redirected", result.getString("first"))
            assertEquals("redirected", result.getString("second"))
            assertTrue(result.getBoolean("redirected"))
            assertEquals("network.cancelled", result.getString("cancelCode"))
            assertEquals("TypeError", result.getJSONObject("websocket").getString("name"))
            assertEquals(
                "Holonomy WebSocket is unsupported by SandboxPolicyV2",
                result.getJSONObject("websocket").getString("message"),
            )
            val capturedBodies = networkDiagnostics(output.events, 1L)
                .filter { event -> event.optString("type") == "dataReceived" && event.has("dataBase64") }
                .map { event ->
                    Base64.decode(event.getString("dataBase64"), Base64.DEFAULT).toString(Charsets.UTF_8)
                }
            assertTrue("redirected body was not captured in diagnostics", capturedBodies.contains("redirected"))
        } finally {
            harness.close()
        }
    }

    @Test
    fun capabilityNetworkRejectsPrivateDnsAsPolicyDeniedBeforeTransport() {
        val fixture = capabilityNetworkFixture(CAPABILITY_NETWORK_PRIVATE_FIXTURE_ASSET)
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("network-private-deny")
        try {
            val created = harness.create(
                runtimeId,
                capabilityNetworkRuntimeSpec(
                    fixture,
                    runtimeId,
                    initialControls = emptyList(),
                    sandboxPolicy = privateDenyPolicy(),
                ),
            )
            assertTrue(created.ack.accepted)
            assertTrue(harness.start(runtimeId).ack.accepted)
            val output = harness.awaitOutput(runtimeId, "capability private DNS denial") { snapshot ->
                snapshot.events.any { event -> event.chunk.contains(CAPABILITY_NETWORK_PRIVATE_OUTPUT_MARKER) }
            }
            val result = JSONObject(
                output.events.first { event -> event.chunk.contains(CAPABILITY_NETWORK_PRIVATE_OUTPUT_MARKER) }
                    .chunk.substringAfter(CAPABILITY_NETWORK_PRIVATE_OUTPUT_MARKER).trim(),
            )
            assertEquals("holo.policy_denied", result.getString("code"))
            assertFalse(networkDiagnostics(output.events, 1L).any { event ->
                event.optString("type") == "responseReceived"
            })
        } finally {
            harness.close()
        }
    }

    @Test
    fun commandV2NetworkControlRestartAndLateEventFencingUseTheRealService() {
        E2eNativeHostDiagnostics.resetMockOnlyDispatches()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("network")
        try {
            val created = harness.create(
                runtimeId,
                runtimeSpec(
                    source = networkEntrySource(),
                    initialControls = listOf(
                        SessionControlOperation(
                            NETWORK_RULES_REPLACE,
                            initialNetworkRuleSet().toString(),
                        ),
                    ),
                    sandboxPolicy = mockOnlyPolicy(),
                ),
            )
            assertTrue(created.ack.accepted)
            assertEquals(SessionRuntimePhase.CREATED, created.state?.phase)
            assertEquals(SessionIsolation.LOGICAL_RUNTIME, created.state?.isolation)

            val started = harness.start(runtimeId)
            assertTrue(started.ack.accepted)
            assertEquals(1L, started.ack.generation)
            assertEquals(SessionRuntimePhase.RUNNING, started.state?.phase)

            val initialOutput = harness.awaitOutput(runtimeId, "initial mocked fetch and network diagnostics") { output ->
                output.events.any { event -> event.generation == 1L && event.chunk.contains("INITIAL:initial-v1") } &&
                    networkDiagnosticTypes(output.events, 1L).containsAll(
                        setOf("requestWillBeSent", "responseReceived", "loadingFinished"),
                    )
            }
            assertFalse(initialOutput.events.any { event -> event.chunk.contains("INITIAL_ERROR:") })
            assertEquals(0, E2eNativeHostDiagnostics.mockOnlyDispatchCount())

            val status = harness.execute(
                StatusRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 1),
            )
            assertTrue(status.ack.accepted)
            assertEquals(SessionRuntimePhase.RUNNING, status.state?.phase)
            assertTrue(status.output!!.events.any { event -> event.chunk.contains("INITIAL:initial-v1") })

            val revised = harness.execute(
                ControlRuntimeCommand(
                    runtimeId = runtimeId,
                    commandId = harness.commandId(),
                    expectedGeneration = 1,
                    control = SessionControlOperation(
                        NETWORK_RULES_REPLACE,
                        JSONObject()
                            .put("rules", liveNetworkRuleSet())
                            .put("expectedRevision", "1")
                            .toString(),
                    ),
                ),
            )
            assertTrue(revised.ack.accepted)
            val liveOutput = harness.awaitOutput(runtimeId, "live network rule revision") { output ->
                output.events.any { event -> event.generation == 1L && event.chunk.contains("LIVE:live-v2") }
            }
            assertFalse(liveOutput.events.any { event -> event.chunk.contains("QUERY_MATCH_LEAK:") })
            assertEquals(0, E2eNativeHostDiagnostics.mockOnlyDispatchCount())

            val restarted = harness.execute(
                RestartRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 1),
            )
            assertTrue(restarted.ack.accepted)
            assertEquals(2L, restarted.ack.generation)
            assertEquals(SessionRuntimePhase.RUNNING, restarted.state?.phase)
            harness.track(runtimeId, 2)
            harness.awaitOutput(runtimeId, "fresh engine output for generation two") { output ->
                output.events.any { event -> event.generation == 2L && event.chunk.contains("INITIAL:initial-v1") }
            }

            val staleStop = harness.execute(
                StopRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 1),
            )
            assertEquals(SessionControlErrorCode.GENERATION_CONFLICT, staleStop.ack.errorCode)
            assertEquals(2L, staleStop.state?.generation)
            val staleControl = harness.execute(
                ControlRuntimeCommand(
                    runtimeId,
                    harness.commandId(),
                    1,
                    SessionControlOperation(NETWORK_RULES_REPLACE, liveNetworkRuleSet().toString()),
                ),
            )
            assertEquals(SessionControlErrorCode.GENERATION_CONFLICT, staleControl.ack.errorCode)

            val disposed = harness.execute(
                DisposeRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 2),
            )
            assertTrue(disposed.ack.accepted)
            assertEquals(SessionRuntimePhase.DISPOSED, disposed.state?.phase)
            val sequenceAfterDispose = disposed.state!!.nextOutputSequence
            SystemClock.sleep(LATE_OUTPUT_WINDOW_MS)
            val afterDispose = harness.execute(
                StatusRuntimeCommand(runtimeId, harness.commandId(), expectedGeneration = 2),
            )
            assertEquals(SessionRuntimePhase.DISPOSED, afterDispose.state?.phase)
            assertEquals(sequenceAfterDispose, afterDispose.state?.nextOutputSequence)
            assertFalse(
                afterDispose.output!!.events.any { event ->
                    event.generation == 2L && event.chunk.contains("LIVE:")
                },
            )
            harness.forget(runtimeId)
        } finally {
            harness.close()
        }
    }

    @Test
    fun twoLogicalRuntimesStartConcurrentlyWithoutSharingOutput() {
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val alpha = harness.runtimeId("alpha")
        val beta = harness.runtimeId("beta")
        try {
            assertTrue(harness.create(alpha, runtimeSpec("console.log('RUNTIME:ALPHA')")).ack.accepted)
            assertTrue(harness.create(beta, runtimeSpec("console.log('RUNTIME:BETA')")).ack.accepted)

            val alphaStart = StartRuntimeCommand(alpha, harness.commandId(), expectedGeneration = 0)
            val betaStart = StartRuntimeCommand(beta, harness.commandId(), expectedGeneration = 0)
            harness.submit(alphaStart)
            harness.submit(betaStart)
            val alphaReply = harness.awaitReply(alphaStart.commandId)
            val betaReply = harness.awaitReply(betaStart.commandId)
            assertEquals(SessionRuntimePhase.RUNNING, alphaReply.state?.phase)
            assertEquals(SessionRuntimePhase.RUNNING, betaReply.state?.phase)
            harness.track(alpha, 1)
            harness.track(beta, 1)

            val alphaStatus = harness.execute(StatusRuntimeCommand(alpha, harness.commandId(), 1))
            val betaStatus = harness.execute(StatusRuntimeCommand(beta, harness.commandId(), 1))
            assertEquals(SessionRuntimePhase.RUNNING, alphaStatus.state?.phase)
            assertEquals(SessionRuntimePhase.RUNNING, betaStatus.state?.phase)
            assertTrue(alphaStatus.output!!.events.any { event -> event.chunk.contains("RUNTIME:ALPHA") })
            assertFalse(alphaStatus.output!!.events.any { event -> event.chunk.contains("RUNTIME:BETA") })
            assertTrue(betaStatus.output!!.events.any { event -> event.chunk.contains("RUNTIME:BETA") })
            assertFalse(betaStatus.output!!.events.any { event -> event.chunk.contains("RUNTIME:ALPHA") })
        } finally {
            harness.close()
        }
    }

    @Test
    fun defaultDenyAndUnsupportedFilesystemFailClosedBeforeNativeNetworkUse() {
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val defaultDeny = harness.runtimeId("default-deny")
        val unsupportedFilesystem = harness.runtimeId("filesystem")
        try {
            assertTrue(
                harness.create(
                    defaultDeny,
                    runtimeSpec(
                        """
                        console.log('FETCH_TYPE:' + typeof fetch)
                        try {
                          await fetch('https://denied.example/path')
                          console.error('DEFAULT_DENY_LEAK')
                        } catch (error) {
                          console.log('DEFAULT_DENY:' + (error?.code ?? error?.message ?? 'unavailable'))
                        }
                        """.trimIndent(),
                    ),
                ).ack.accepted,
            )
            assertTrue(harness.start(defaultDeny).ack.accepted)
            val denied = harness.awaitOutput(defaultDeny, "default sandbox denies network") { output ->
                output.events.any { event -> event.chunk.contains("DEFAULT_DENY:") }
            }
            assertFalse(denied.events.any { event -> event.chunk.contains("DEFAULT_DENY_LEAK") })

            val rejected = harness.create(
                unsupportedFilesystem,
                runtimeSpec(
                    "console.error('FILESYSTEM_ENGINE_STARTED')",
                    sandboxPolicy = SessionSandboxPolicy(
                        filesystem = SessionSandboxFilesystemPolicy(SessionSandboxFilesystemAccess.SANDBOXED),
                    ),
                ),
            )
            assertEquals(SessionControlErrorCode.SANDBOX_CAPABILITY_UNSUPPORTED, rejected.ack.errorCode)
            assertEquals(0L, rejected.ack.generation)
        } finally {
            harness.close()
        }
    }

    @Test
    fun restrictedPolicyAllowsExactMockOriginAndRejectsOtherAndPrivateOrigins() {
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("restricted")
        try {
            val source = """
                const checks = [
                  ['$INITIAL_MOCK_URL', 'EXACT'],
                  ['https://other.example/path', 'OTHER'],
                  ['http://127.0.0.1:2/private', 'PRIVATE'],
                ]
                for (const [url, marker] of checks) {
                  try {
                    const response = await fetch(url)
                    console.log(marker + ':OK:' + await response.text())
                  } catch (error) {
                    console.log(marker + ':DENIED:' + (error?.code ?? error?.message ?? 'unknown'))
                  }
                }
            """.trimIndent()
            val created = harness.create(
                runtimeId,
                runtimeSpec(
                    source = source,
                    initialControls = listOf(
                        SessionControlOperation(NETWORK_RULES_REPLACE, initialNetworkRuleSet().toString()),
                    ),
                    sandboxPolicy = restrictedPolicy(),
                ),
            )
            assertTrue(created.ack.accepted)
            assertTrue(harness.start(runtimeId).ack.accepted)
            val output = harness.awaitOutput(runtimeId, "restricted sandbox authority") { snapshot ->
                val chunks = snapshot.events.map(SessionOutputEvent::chunk)
                chunks.any { it.contains("EXACT:OK:initial-v1") } &&
                    chunks.any { it.contains("OTHER:DENIED:") } &&
                    chunks.any { it.contains("PRIVATE:DENIED:") }
            }
            assertFalse(output.events.any { event -> event.chunk.contains("OTHER:OK:") })
            assertFalse(output.events.any { event -> event.chunk.contains("PRIVATE:OK:") })
        } finally {
            harness.close()
        }
    }

    private fun targetContext() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun runtimeSpec(
        source: String,
        initialControls: List<SessionControlOperation> = emptyList(),
        sandboxPolicy: SessionSandboxPolicy = SessionSandboxPolicy(),
    ): SessionRuntimeSpec = SessionRuntimeSpec(
        entryUrl = ENTRY_URL,
        modules = listOf(SessionModuleSpec(ENTRY_URL, source)),
        isolation = SessionIsolation.LOGICAL_RUNTIME,
        initialControls = initialControls,
        sandboxPolicy = sandboxPolicy,
    )

    private fun capabilityNetworkFixture(
        asset: String = CAPABILITY_NETWORK_FIXTURE_ASSET,
    ): JSONObject = targetContext().assets
        .open(asset)
        .bufferedReader()
        .use { JSONObject(it.readText()) }

    private fun capabilityNetworkRuntimeSpec(
        fixture: JSONObject,
        runtimeId: ai.oneworks.holonomy.session.RuntimeId,
        initialControls: List<SessionControlOperation> = listOf(
            SessionControlOperation(NETWORK_RULES_REPLACE, capabilityContinuationRuleSet().toString()),
        ),
        sandboxPolicy: SessionSandboxPolicy = mockOnlyPolicy(),
    ): SessionRuntimeSpec {
        val capabilityRuntime = fixture.getJSONObject("capabilityRuntime").put("processId", runtimeId.value)
        val entryUrl = fixture.getString("entryUrl")
        val modules = fixture.getJSONArray("modules")
        return SessionRuntimeSpec(
            entryUrl = entryUrl,
            modules = List(modules.length()) { index ->
                val module = modules.getJSONObject(index)
                SessionModuleSpec(module.getString("url"), module.getString("source"))
            },
            isolation = SessionIsolation.LOGICAL_RUNTIME,
            initialControls = initialControls,
            sandboxPolicy = sandboxPolicy,
            capabilityRuntimeJson = capabilityRuntime.toString(),
        )
    }

    private fun mockOnlyPolicy() = SessionSandboxPolicy(
        network = SessionSandboxNetworkPolicy(
            access = SessionSandboxNetworkAccess.MOCK_ONLY,
            allowedOrigins = setOf(MOCK_ORIGIN),
            allowedSchemes = setOf("https"),
            allowPrivateNetwork = false,
        ),
    )

    private fun restrictedPolicy() = SessionSandboxPolicy(
        network = SessionSandboxNetworkPolicy(
            access = SessionSandboxNetworkAccess.RESTRICTED,
            allowedOrigins = setOf(MOCK_ORIGIN, "http://127.0.0.1:2"),
            allowedSchemes = setOf("http", "https"),
            allowPrivateNetwork = false,
        ),
    )

    private fun privateDenyPolicy() = SessionSandboxPolicy(
        network = SessionSandboxNetworkPolicy(
            access = SessionSandboxNetworkAccess.RESTRICTED,
            allowedOrigins = setOf(PRIVATE_DENY_ORIGIN),
            allowedSchemes = setOf("http"),
            allowPrivateNetwork = false,
        ),
    )

    private fun realRestrictedPolicy() = SessionSandboxPolicy(
        network = SessionSandboxNetworkPolicy(
            access = SessionSandboxNetworkAccess.RESTRICTED,
            allowedOrigins = setOf("http://127.0.0.1:$REAL_NETWORK_PORT"),
            allowedSchemes = setOf("http"),
            allowPrivateNetwork = true,
        ),
    )

    private fun networkEntrySource(): String = """
        const initialUrl = '$INITIAL_MOCK_URL'
        const liveUrl = '$LIVE_MOCK_URL'
        const missingDuplicateUrl = '$MISSING_DUPLICATE_MOCK_URL'
        setTimeout(async () => {
          try {
            const initial = await fetch(initialUrl)
            console.log('INITIAL:' + await initial.text())
          } catch (error) {
            console.error('INITIAL_ERROR:' + (error?.code ?? error?.message ?? 'unknown'))
          }
        }, 0)
        const awaitLiveRevision = async () => {
          try {
            const missingDuplicate = await fetch(missingDuplicateUrl)
            if (await missingDuplicate.text() === 'live-v2') {
              console.error('QUERY_MATCH_LEAK:duplicate')
            }
          } catch {}
          try {
            const live = await fetch(liveUrl)
            const body = await live.text()
            if (body === 'live-v2') {
              console.log('LIVE:' + body)
              return
            }
            if (body === 'initial-v1') console.error('QUERY_MATCH_LEAK:exact')
          } catch {}
          setTimeout(awaitLiveRevision, $LIVE_RETRY_DELAY_MS)
        }
        setTimeout(awaitLiveRevision, 0)
        console.log('ENTRY_READY')
    """.trimIndent()

    private fun initialNetworkRuleSet() = networkRuleSet(
        body = "initial-v1",
        ruleId = "initial-rule",
        queryMode = "exact",
        queryEntries = listOf("tag" to "alpha", "tag" to "beta", "phase" to "initial"),
    )

    private fun liveNetworkRuleSet() = networkRuleSet(
        body = "live-v2",
        ruleId = "live-rule",
        queryMode = "subset",
        queryEntries = listOf("tag" to "alpha", "tag" to "beta"),
    )

    private fun capabilityContinuationRuleSet() = JSONObject().apply {
        put("mode", "failClosed")
        put(
            "rules",
            JSONArray()
                .put(
                    JSONObject()
                        .put("id", "redirect")
                        .put("priority", 300)
                        .put(
                            "match",
                            JSONObject()
                                .put("method", "GET")
                                .put("origin", MOCK_ORIGIN)
                                .put("path", JSONObject().put("op", "exact").put("value", "/redirect")),
                        )
                        .put(
                            "action",
                            JSONObject()
                                .put("type", "respond")
                                .put("status", 302)
                                .put(
                                    "headers",
                                    JSONArray().put(
                                        JSONArray().put("location").put("$MOCK_ORIGIN/redirected"),
                                    ),
                                ),
                        ),
                )
                .put(
                    JSONObject()
                        .put("id", "redirected")
                        .put("priority", 200)
                        .put(
                            "match",
                            JSONObject()
                                .put("method", "GET")
                                .put("origin", MOCK_ORIGIN)
                                .put("path", JSONObject().put("op", "exact").put("value", "/redirected")),
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
                                .put("body", JSONObject().put("kind", "utf8").put("value", "redirected")),
                        ),
                )
                .put(
                    JSONObject()
                        .put("id", "slow")
                        .put("priority", 100)
                        .put(
                            "match",
                            JSONObject()
                                .put("method", "GET")
                                .put("origin", MOCK_ORIGIN)
                                .put("path", JSONObject().put("op", "exact").put("value", "/slow")),
                        )
                        .put(
                            "action",
                            JSONObject()
                                .put("type", "respond")
                                .put("status", 200)
                                .put("delayMs", 1_000)
                                .put("body", JSONObject().put("kind", "utf8").put("value", "late")),
                        ),
                ),
        )
    }

    private fun networkRuleSet(
        body: String,
        ruleId: String,
        queryMode: String,
        queryEntries: List<Pair<String, String>>,
    ) = JSONObject().apply {
        put("mode", "failClosed")
        put(
            "rules",
            JSONArray().put(
                JSONObject().apply {
                    put("id", ruleId)
                    put("priority", 100)
                    put(
                        "match",
                        JSONObject()
                            .put("method", "GET")
                            .put("origin", MOCK_ORIGIN)
                            .put("path", JSONObject().put("op", "exact").put("value", MOCK_PATH))
                            .put(
                                "query",
                                JSONObject()
                                    .put("mode", queryMode)
                                    .put(
                                        "entries",
                                        JSONArray().apply {
                                            queryEntries.forEach { (name, value) ->
                                                put(JSONArray().put(name).put(value))
                                            }
                                        },
                                    ),
                            ),
                    )
                    put(
                        "action",
                        JSONObject()
                            .put("type", "respond")
                            .put("status", 200)
                            .put(
                                "headers",
                                JSONArray().put(JSONArray().put("content-type").put("text/plain")),
                            )
                            .put("body", JSONObject().put("kind", "utf8").put("value", body)),
                    )
                },
            ),
        )
    }

    private fun networkDiagnosticTypes(
        events: List<SessionOutputEvent>,
        generation: Long,
    ): Set<String> = events.asSequence()
        .filter { event -> event.generation == generation && event.stream == SessionOutputStream.NETWORK }
        .mapNotNull { event -> runCatching { JSONObject(event.chunk).getString("type") }.getOrNull() }
        .toSet()

    private fun networkDiagnostics(
        events: List<SessionOutputEvent>,
        generation: Long,
    ): List<JSONObject> = events.asSequence()
        .filter { event -> event.generation == generation && event.stream == SessionOutputStream.NETWORK }
        .mapNotNull { event -> runCatching { JSONObject(event.chunk) }.getOrNull() }
        .toList()

    private companion object {
        private const val CAPABILITY_NETWORK_FIXTURE_ASSET = "runtime/capability-network-continuation-v1.json"
        private const val CAPABILITY_NETWORK_OUTPUT_MARKER = "M3_NETWORK_ANDROID:"
        private const val CAPABILITY_NETWORK_PRIVATE_FIXTURE_ASSET = "runtime/capability-network-private-deny-v1.json"
        private const val CAPABILITY_NETWORK_PRIVATE_OUTPUT_MARKER = "M3_NETWORK_PRIVATE_ANDROID:"
        private const val CAPABILITY_NETWORK_REAL_FIXTURE_ASSET = "runtime/capability-network-real-v1.json"
        private const val CAPABILITY_NETWORK_REAL_OUTPUT_MARKER = "M3_NETWORK_REAL_ANDROID:"
        private const val ENTRY_URL = "fixture+session://runtime/entry.mjs"
        private const val MOCK_ORIGIN = "https://mock.example"
        private const val MOCK_PATH = "/session"
        private const val INITIAL_MOCK_URL = "$MOCK_ORIGIN$MOCK_PATH?tag=alpha&tag=beta&phase=initial"
        private const val LIVE_MOCK_URL = "$MOCK_ORIGIN$MOCK_PATH?tag=alpha&tag=beta&phase=live&extra=allowed"
        private const val MISSING_DUPLICATE_MOCK_URL = "$MOCK_ORIGIN$MOCK_PATH?tag=alpha&phase=live&extra=allowed"
        private const val NETWORK_RULES_REPLACE = "network.rules.replace"
        private const val PRIVATE_DENY_ORIGIN = "http://ip6-localhost:2"
        private const val REAL_NETWORK_PORT = 18_087
        private const val LIVE_RETRY_DELAY_MS = 50L
        private val LATE_OUTPUT_WINDOW_MS = TimeUnit.MILLISECONDS.toMillis(250)
    }
}
