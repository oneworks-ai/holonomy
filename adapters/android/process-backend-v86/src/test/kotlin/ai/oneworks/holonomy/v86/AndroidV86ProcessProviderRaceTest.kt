package ai.oneworks.holonomy.v86

import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidV86ProcessProviderRaceTest {
    @Test
    fun `process network resolution is pinned through preflight verify and execute`() {
        val transport = ResolvingTransport(
            mutableListOf(
                listOf("93.184.216.35", "93.184.216.34"),
                listOf("93.184.216.34", "93.184.216.35"),
                listOf("93.184.216.34"),
                listOf("93.184.216.35"),
            ),
        )
        val fixture = fixture(FakeBackend(), transport)
        try {
            val preflight = JSONObject(fixture.provider.invoke(networkRequest("network-1", "preflight").toString()))
            assertTrue(preflight.toString(), preflight.getBoolean("ok"))
            val evidence = preflight.getJSONObject("value").getJSONArray("requests")
                .getJSONObject(0).getJSONObject("evidence")
            assertEquals(
                listOf("93.184.216.34", "93.184.216.35"),
                evidence.getJSONArray("addresses").strings(),
            )
            val verification = JSONObject(fixture.provider.invoke(networkRequest("network-1", "verify").toString()))
            assertTrue(verification.toString(), verification.getBoolean("ok"))

            val execute = networkRequest("network-1", "execute")
                .put("resolutionAuthorityBindings", JSONArray().put(networkAuthority()))
                .put("resolutionResources", JSONArray().put(networkResource()))
                .put(
                    "resolutionTokens",
                    JSONArray().put(
                        JSONObject()
                            .put("evidenceDigest", evidenceDigest(evidence))
                            .put("expiresAtMonotonicMs", evidence.getLong("expiresAtMonotonicMs"))
                            .put("generation", 7)
                            .put("parentRequestId", "network-1")
                            .put("requestedSemanticDigest", "3".repeat(64))
                            .put("resolvedSemanticDigest", "3".repeat(64)),
                    ),
                )
            val terminal = JSONObject(fixture.provider.invoke(execute.toString()))
            assertTrue(terminal.toString(), terminal.getBoolean("ok"))
            assertEquals(
                listOf("93.184.216.34", "93.184.216.35"),
                terminal.getJSONObject("value").getJSONObject("resolution")
                    .getJSONArray("addresses").strings(),
            )

            assertTrue(
                JSONObject(fixture.provider.invoke(networkRequest("network-2", "preflight").toString())).getBoolean("ok"),
            )
            val rebound = JSONObject(fixture.provider.invoke(networkRequest("network-2", "verify").toString()))
            assertFalse(rebound.getBoolean("ok"))
            assertEquals("resource.invalid", rebound.getJSONObject("error").getString("code"))
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `close waits for a committed spawn and fences late backend events`() {
        val submitted = CountDownLatch(1)
        val releaseSubmit = CountDownLatch(1)
        val fixture = fixture(BlockingBackend(submitted, releaseSubmit))
        val executor = Executors.newFixedThreadPool(2)
        try {
            val invocation = executor.submit<String> { fixture.provider.invoke(spawnRequest()) }
            val reachedSubmit = submitted.await(1, TimeUnit.SECONDS)
            assertTrue(if (reachedSubmit) "" else invocation.get(1, TimeUnit.SECONDS), reachedSubmit)
            val closing = executor.submit<Unit> { fixture.provider.close() }
            assertFalse(closing.isDone)

            releaseSubmit.countDown()
            val result = JSONObject(invocation.get(1, TimeUnit.SECONDS))
            assertTrue(result.toString(), result.getBoolean("ok"))
            closing.get(1, TimeUnit.SECONDS)

            val publication = result.getJSONArray("resources").getJSONObject(0)
            val bindingId = publication.getString("bindingId")
            val resourceId = publication.getJSONObject("processInstance").getString("processResourceId")
            assertFalse(fixture.provider.ownsResource(bindingId))
            fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
            assertEquals(1, fixture.backend.commands.size)
            assertEquals(1, fixture.backend.closeCount.get())
        } finally {
            executor.shutdownNow()
            fixture.manager.close()
        }
    }

    @Test
    fun `spawn submit failure invalidates the environment without publishing resources`() {
        val fixture = fixture(FakeBackend(failSpawn = true))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertFalse(result.getBoolean("ok"))
            assertEquals("provider.unavailable", result.getJSONObject("error").getString("code"))
            assertEquals(emptySet<String>(), fixture.manager.activeEnvironmentIds())
            assertEquals(1, fixture.backend.closeCount.get())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `pre-spawn signals submit only the strongest terminal intent`() {
        val fixture = fixture(FakeBackend())
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertTrue(result.getBoolean("ok"))
            val publication = result.getJSONArray("resources").getJSONObject(0)
            val bindingId = publication.getString("bindingId")
            val resourceId = publication.getJSONObject("processInstance").getString("processResourceId")

            assertTrue(JSONObject(fixture.provider.invoke(signalRequest(bindingId, "SIGTERM"))).getBoolean("ok"))
            assertTrue(JSONObject(fixture.provider.invoke(signalRequest(bindingId, "SIGKILL"))).getBoolean("ok"))
            fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
            assertTrue(JSONObject(fixture.provider.invoke(signalRequest(bindingId, "SIGTERM"))).getBoolean("ok"))

            val signals = fixture.backend.commands.filter { command -> command.optString("operation") == "signal" }
            assertEquals(1, signals.size)
            assertEquals("SIGKILL", signals.single().getString("signal"))
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `backend failure terminates a published process exactly once`() {
        val fixture = fixture(FakeBackend())
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertTrue(result.toString(), result.getBoolean("ok"))
            val publication = result.getJSONArray("resources").getJSONObject(0)
            val bindingId = publication.getString("bindingId")
            val resourceId = publication.getJSONObject("processInstance").getString("processResourceId")
            val events = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(
                bindingId,
                RuntimeCapabilityResourceEventSink { source -> events += JSONObject(source) },
            )?.use {
                fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
                val failure = JSONObject()
                    .put("code", "provider.unavailable")
                    .put("environmentId", fixture.environmentId())
                    .put("event", "backend-error")
                fixture.provider.emit(failure)
                fixture.provider.emit(failure)
            }

            assertEquals(listOf("spawn", "error", "close"), events.map { it.getString("event") })
            assertEquals(1, fixture.backend.closeCount.get())
            assertEquals(emptySet<String>(), fixture.manager.activeEnvironmentIds())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `output limit selects one error and one process terminal`() {
        val fixture = fixture(FakeBackend(), policy = processPolicy(maxStdoutBytes = 1))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertTrue(result.toString(), result.getBoolean("ok"))
            val publication = result.getJSONArray("resources").getJSONObject(0)
            val bindingId = publication.getString("bindingId")
            val resourceId = publication.getJSONObject("processInstance").getString("processResourceId")
            val events = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(
                bindingId,
                RuntimeCapabilityResourceEventSink { source -> events += JSONObject(source) },
            )?.use {
                fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
                val output = JSONObject()
                    .put("bytes", JSONArray().put(1).put(2))
                    .put("environmentId", fixture.environmentId())
                    .put("event", "stdout")
                    .put("processId", 17)
                fixture.provider.emit(output)
                fixture.provider.emit(output)
                val close = JSONObject()
                    .put("code", 137)
                    .put("environmentId", fixture.environmentId())
                    .put("event", "close")
                    .put("processId", 17)
                    .put("signal", "SIGKILL")
                fixture.provider.emit(close)
                fixture.provider.emit(close)
            }

            assertEquals(listOf("spawn", "error", "close"), events.map { it.getString("event") })
            val signals = fixture.backend.commands.filter { command -> command.optString("operation") == "signal" }
            assertEquals(1, signals.size)
            assertEquals("SIGKILL", signals.single().getString("signal"))
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    private fun fixture(
        backend: FakeBackend,
        networkTransport: AndroidV86NetworkTransport? = null,
        policy: JSONObject = processPolicy(),
    ): Fixture {
        val manager = AndroidV86EnvironmentManager(
            processId = "runtime-process",
            generation = 7,
            defaultScope = "processTree",
            startupTimeoutMs = 1_000,
            eventSink = AndroidV86ProcessEventSink {},
            networkTransport = networkTransport,
        ) { environmentId, _, _ -> backend.apply { this.environmentId = environmentId } }
        manager.start(RuntimeTrustedBackendHost { _, _, _ -> }).get()
        return Fixture(
            backend,
            manager,
            AndroidV86ProcessProvider(7, policy, processProfile(), manager, networkTransport),
        )
    }

    private fun networkRequest(requestId: String, phase: String) = JSONObject()
        .put("authorityBindings", JSONArray().put(networkAuthority()))
        .put("brokerMonotonicMs", 1_000.0)
        .put(
            "invocationBinding",
            JSONObject()
                .put("generation", 7)
                .put("invocationBindingDigest", "4".repeat(64))
                .put("semanticResourceDigest", "3".repeat(64)),
        )
        .put("member", "authorizeProcessNetwork")
        .put("operation", "process.network.connect")
        .put("providerPhase", phase)
        .put("requestId", requestId)
        .put("resource", networkResource())

    private fun networkResource() = JSONObject()
        .put("hostname", "example.test")
        .put("kind", "processNetworkEndpoint")
        .put("port", 443)
        .put("semanticResourceDigest", "3".repeat(64))
        .put("transport", "tls")

    private fun networkAuthority() = JSONObject()
        .put("capabilityName", "host.process.network")
        .put("constraints", JSONObject().put("maxSockets", 1))
        .put("providerModule", "host.process")

    private fun evidenceDigest(evidence: JSONObject): String {
        val value = JSONArray().put("resolutionEvidence").put(evidence).toString()
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }

    private fun spawnRequest() = JSONObject()
        .put(
            "arguments",
            JSONObject()
                .put("args", JSONArray())
                .put("environmentScope", "processTree")
                .put("executableId", "tool")
                .put("options", JSONObject()),
        )
        .put("authorityBindings", JSONArray().put(executeAuthority()))
        .put("member", "spawn")
        .put("operation", "process.program.spawn")
        .put(
            "resource",
            JSONObject()
                .put("environmentScope", "processTree")
                .put("invocation", "program")
                .put("kind", "processExecutable")
                .put("semanticResourceDigest", "sha256:tool"),
        )
        .toString()

    private fun signalRequest(bindingId: String, signal: String) = JSONObject()
        .put("arguments", signal)
        .put("authorityBindings", JSONArray().put(signalAuthority(signal)))
        .put("inheritedBindingId", bindingId)
        .put("member", "kill")
        .put("operation", "process.signal.send")
        .put("resource", JSONObject().put("kind", "processInstance"))
        .toString()

    private fun spawnEvent(environmentId: String, resourceId: String) = JSONObject()
        .put("environmentId", environmentId)
        .put("event", "spawn")
        .put("linuxPid", 101)
        .put("processId", 17)
        .put("resourceId", resourceId)

    private fun executeAuthority() = JSONObject()
        .put("capabilityName", "host.process.execute")
        .put(
            "constraints",
            JSONObject()
                .put("executableIds", JSONArray().put("tool"))
                .put("limits", JSONObject().put("maxConcurrentProcesses", 4)),
        )
        .put("providerModule", "host.process")

    private fun signalAuthority(signal: String) = JSONObject()
        .put("capabilityName", "host.process.signal")
        .put("constraints", JSONObject().put("signals", JSONArray().put(signal)))
        .put("providerModule", "host.process")

    private fun processProfile() = JSONObject()
        .put("environment", JSONObject().put("allowedScopes", JSONArray().put("processTree")))
        .put(
            "executables",
            JSONArray().put(
                JSONObject()
                    .put("executable", JSONObject().put("kind", "guestPath").put("path", "/bin/tool"))
                    .put("executableId", "tool")
                    .put("fixedArgs", JSONArray())
                    .put("shell", false),
            ),
        )

    private fun processPolicy(maxStdoutBytes: Int = 64 * 1_024) = JSONObject()
        .put("environment", JSONObject().put("allowedNames", JSONArray()).put("maxValueBytes", 64))
        .put(
            "executables",
            JSONArray().put(JSONObject().put("argumentBytes", 1_024).put("executableId", "tool")),
        )
        .put(
            "limits",
            JSONObject()
                .put("maxConcurrentProcesses", 4)
                .put("maxExecutionTimeMs", 60_000)
                .put("maxProcessTreeDepth", 4)
                .put("maxStderrBytes", 64 * 1_024)
                .put("maxStdinBytes", 64 * 1_024)
                .put("maxStdoutBytes", maxStdoutBytes)
                .put("maxTotalProcesses", 8),
        )

    private data class Fixture(
        val backend: FakeBackend,
        val manager: AndroidV86EnvironmentManager,
        val provider: AndroidV86ProcessProvider,
    ) {
        fun environmentId(): String = backend.environmentId
    }

    private open class FakeBackend(
        private val failSpawn: Boolean = false,
    ) : AndroidV86EnvironmentBackend {
        val closeCount = AtomicInteger()
        val commands = mutableListOf<JSONObject>()
        lateinit var environmentId: String

        override fun start(host: RuntimeTrustedBackendHost) = CompletableFuture.completedFuture(Unit)

        @Synchronized
        open override fun submit(command: JSONObject) {
            commands += JSONObject(command.toString())
            if (failSpawn && command.getString("operation") == "spawn") error("spawn failed")
        }

        override fun close() {
            closeCount.incrementAndGet()
        }
    }

    private class BlockingBackend(
        private val submitted: CountDownLatch,
        private val releaseSubmit: CountDownLatch,
    ) : FakeBackend() {
        override fun submit(command: JSONObject) {
            super.submit(command)
            if (command.getString("operation") == "spawn") {
                submitted.countDown()
                check(releaseSubmit.await(1, TimeUnit.SECONDS))
            }
        }
    }

    private class ResolvingTransport(
        private val values: MutableList<List<String>>,
    ) : AndroidV86NetworkTransport {
        override fun resolve(hostname: String): List<String> = values.removeAt(0)

        override fun execute(request: JSONObject, authorizationTerminal: JSONObject) =
            AndroidV86NetworkTransport.success()
    }

    private fun JSONArray.strings() = List(length(), ::getString)
}
