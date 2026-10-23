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

    @Test
    fun `pre-spawn stdin write and end advance only after matching ACK`() {
        val fixture = fixture(FakeBackend())
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertTrue(result.toString(), result.getBoolean("ok"))
            val publications = result.getJSONArray("resources")
            val resourceId = publications.getJSONObject(0).getJSONObject("processInstance")
                .getString("processResourceId")
            val stdinBindingId = publications.getJSONObject(1).getString("bindingId")
            val events = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(
                stdinBindingId,
                RuntimeCapabilityResourceEventSink { source -> events += JSONObject(source) },
            )?.use {
                assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "write", 1))).getBoolean("ok"))
                assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "end", 2))).getBoolean("ok"))
                assertEquals(listOf("spawn"), fixture.backend.commands.map { command -> command.getString("operation") })

                fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
                assertEquals(listOf("spawn", "stdin"), fixture.backend.commands.map { command -> command.getString("operation") })
                val write = fixture.backend.commands.last()
                val writeAck = stdinEvent(fixture.environmentId(), "ack", write)
                fixture.provider.emit(writeAck)
                assertEquals(listOf("spawn", "stdin", "end"), fixture.backend.commands.map { command -> command.getString("operation") })
                fixture.provider.emit(writeAck)
                val end = fixture.backend.commands.last()
                fixture.provider.emit(stdinEvent(fixture.environmentId(), "ack", end))
                fixture.provider.emit(stdinEvent(fixture.environmentId(), "ack", end))
                assertEquals(listOf(1L, 2L), events.filter { event -> event.getString("event") == "callback" }
                    .map { event -> event.getLong("callbackId") })
                assertTrue(events.filter { event -> event.getString("event") == "callback" }
                    .all { event -> !event.has("error") })

                fixture.provider.emit(
                    JSONObject().put("environmentId", fixture.environmentId()).put("event", "close")
                        .put("processId", 17).put("code", 0).put("signal", JSONObject.NULL),
                )
                fixture.provider.emit(writeAck)
                assertEquals(2, events.count { event -> event.getString("event") == "callback" })
            }
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `stdin dispatch failure settles each callback once and fences late events`() {
        val fixture = fixture(FakeBackend(failOperation = "end"))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertTrue(result.toString(), result.getBoolean("ok"))
            val publications = result.getJSONArray("resources")
            val resourceId = publications.getJSONObject(0).getJSONObject("processInstance")
                .getString("processResourceId")
            val childBindingId = publications.getJSONObject(0).getString("bindingId")
            val stdinBindingId = publications.getJSONObject(1).getString("bindingId")
            val childEvents = mutableListOf<JSONObject>()
            val stdinEvents = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(
                childBindingId,
                RuntimeCapabilityResourceEventSink { source -> childEvents += JSONObject(source) },
            )?.use {
                fixture.provider.subscribeResource(
                    stdinBindingId,
                    RuntimeCapabilityResourceEventSink { source -> stdinEvents += JSONObject(source) },
                )?.use {
                    assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "write", 1))).getBoolean("ok"))
                    assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "end", 2))).getBoolean("ok"))
                    fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
                    val writeAck = stdinEvent(fixture.environmentId(), "ack", fixture.backend.commands.last())
                    fixture.provider.emit(writeAck)
                    fixture.provider.emit(writeAck)
                    fixture.provider.emit(stdinEvent(fixture.environmentId(), "ack", fixture.backend.commands.last()))
                }
            }
            assertEquals(listOf("spawn", "error", "close"), childEvents.map { event -> event.getString("event") })
            val callbacks = stdinEvents.filter { event -> event.getString("event") == "callback" }
            assertEquals(listOf(1L, 2L), callbacks.map { event -> event.getLong("callbackId") })
            assertFalse(callbacks.first().has("error"))
            assertEquals("ERR_INVALID_STATE", callbacks.last().getJSONObject("error").getString("code"))
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `callback-less stdin error advances end and duplicate error is ignored`() {
        val fixture = fixture(FakeBackend())
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertTrue(result.toString(), result.getBoolean("ok"))
            val publications = result.getJSONArray("resources")
            val resourceId = publications.getJSONObject(0).getJSONObject("processInstance")
                .getString("processResourceId")
            val childBindingId = publications.getJSONObject(0).getString("bindingId")
            val stdinBindingId = publications.getJSONObject(1).getString("bindingId")
            val childEvents = mutableListOf<JSONObject>()
            val stdinEvents = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(
                childBindingId,
                RuntimeCapabilityResourceEventSink { source -> childEvents += JSONObject(source) },
            )?.use {
                fixture.provider.subscribeResource(
                    stdinBindingId,
                    RuntimeCapabilityResourceEventSink { source -> stdinEvents += JSONObject(source) },
                )?.use {
                    assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "write", null))).getBoolean("ok"))
                    assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "end", 2))).getBoolean("ok"))
                    fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
                    val writeError = stdinEvent(fixture.environmentId(), "error", fixture.backend.commands.last())
                    fixture.provider.emit(writeError)
                    fixture.provider.emit(writeError)
                    assertEquals(listOf("spawn", "stdin", "end"), fixture.backend.commands.map { it.getString("operation") })
                    fixture.provider.emit(stdinEvent(fixture.environmentId(), "ack", fixture.backend.commands.last()))
                    assertEquals(listOf("spawn", "error"), childEvents.map { it.getString("event") })
                    assertEquals(listOf(2L), stdinEvents.filter { it.getString("event") == "callback" }
                        .map { it.getLong("callbackId") })
                }
            }
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `cold spawn returns resources immediately and pending roots consume concurrent quota`() {
        val readiness = CompletableFuture<Unit>()
        val policy = processPolicy().apply { getJSONObject("limits").put("maxConcurrentProcesses", 1) }
        val fixture = fixture(FakeBackend(readiness = readiness), policy = policy)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val invocation = executor.submit<String> { fixture.provider.invoke(spawnRequest()) }
            val result = JSONObject(invocation.get(1, TimeUnit.SECONDS))
            assertTrue(result.toString(), result.getBoolean("ok"))
            assertTrue(fixture.backend.commands.isEmpty())
            assertTrue(!readiness.isDone)
            val second = JSONObject(fixture.provider.invoke(spawnRequest()))
            assertEquals("resource.handle_limit", second.getJSONObject("error").getString("code"))
            readiness.complete(Unit)
            assertTrue(fixture.backend.spawnSubmittedLatch.await(1, TimeUnit.SECONDS))
            assertEquals(listOf("spawn"), fixture.backend.commands.map { it.getString("operation") })
        } finally {
            executor.shutdownNow()
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `kill before readiness closes once and late ready never executes`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val publication = result.getJSONArray("resources").getJSONObject(0)
            val bindingId = publication.getString("bindingId")
            val resourceId = publication.getJSONObject("processInstance").getString("processResourceId")
            val events = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink { events += JSONObject(it) })?.use {
                assertTrue(JSONObject(fixture.provider.invoke(signalRequest(bindingId, "SIGKILL"))).getBoolean("ok"))
                fixture.provider.invoke(signalRequest(bindingId, "SIGTERM"))
                readiness.complete(Unit)
                fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
            }
            assertEquals(listOf("close"), events.map { it.getString("event") })
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
            assertTrue(fixture.manager.activeEnvironmentIds().isEmpty())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `released pending child cancels VM without submitting spawn`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val bindingId = result.getJSONArray("resources").getJSONObject(0).getString("bindingId")
            fixture.provider.releaseResource(bindingId)
            fixture.provider.releaseResource(bindingId)
            readiness.complete(Unit)
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
            assertTrue(fixture.manager.activeEnvironmentIds().isEmpty())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `provider close cancels pending VM and fences late readiness`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val bindingId = result.getJSONArray("resources").getJSONObject(0).getString("bindingId")
            val events = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink { events += JSONObject(it) })
            fixture.provider.close()
            fixture.provider.close()
            readiness.complete(Unit)
            assertEquals(listOf("close"), events.map { it.getString("event") })
            assertFalse(fixture.provider.ownsResource(bindingId))
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
        } finally {
            fixture.manager.close()
        }
    }

    @Test
    fun `startup failure produces one error and close for an already returned child`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val bindingId = result.getJSONArray("resources").getJSONObject(0).getString("bindingId")
            val events = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
            val terminal = CountDownLatch(1)
            fixture.provider.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink {
                events += JSONObject(it)
                if (JSONObject(it).getString("event") == "close") terminal.countDown()
            })?.use {
                readiness.completeExceptionally(IllegalStateException("boot failed"))
                assertTrue(terminal.await(1, TimeUnit.SECONDS))
                fixture.provider.emit(JSONObject().put("event", "backend-error").put("environmentId", fixture.environmentId()))
            }
            assertEquals(listOf("error", "close"), events.map { it.getString("event") })
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
            assertTrue(fixture.manager.activeEnvironmentIds().isEmpty())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `manager close terminates pending child and fences late readiness`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val bindingId = result.getJSONArray("resources").getJSONObject(0).getString("bindingId")
            val events = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
            val terminal = CountDownLatch(1)
            fixture.provider.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink {
                events += JSONObject(it)
                if (JSONObject(it).getString("event") == "close") terminal.countDown()
            })?.use {
                fixture.manager.close()
                readiness.complete(Unit)
                assertTrue(terminal.await(1, TimeUnit.SECONDS))
            }
            assertEquals(listOf("error", "close"), events.map { it.getString("event") })
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `startup timeout releases pending VM independently of execution timer`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness), startupTimeoutMs = 50)
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val bindingId = result.getJSONArray("resources").getJSONObject(0).getString("bindingId")
            val events = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
            val terminal = CountDownLatch(1)
            fixture.provider.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink {
                events += JSONObject(it)
                if (JSONObject(it).getString("event") == "close") terminal.countDown()
            })?.use { assertTrue(terminal.await(1, TimeUnit.SECONDS)) }
            readiness.complete(Unit)
            assertEquals(listOf("error", "close"), events.map { it.getString("event") })
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
            assertTrue(fixture.manager.activeEnvironmentIds().isEmpty())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `stdin queues before VM readiness then flushes only after process spawn`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val publications = result.getJSONArray("resources")
            val resourceId = publications.getJSONObject(0).getJSONObject("processInstance").getString("processResourceId")
            val stdinBindingId = publications.getJSONObject(1).getString("bindingId")
            assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "write", 1))).getBoolean("ok"))
            assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "end", 2))).getBoolean("ok"))
            assertTrue(fixture.backend.commands.isEmpty())
            readiness.complete(Unit)
            assertTrue(fixture.backend.spawnSubmittedLatch.await(1, TimeUnit.SECONDS))
            assertEquals(listOf("spawn"), fixture.backend.commands.map { it.getString("operation") })
            fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
            val write = fixture.backend.commands.last()
            assertEquals("stdin", write.getString("operation"))
            fixture.provider.emit(stdinEvent(fixture.environmentId(), "ack", write))
            assertEquals(listOf("spawn", "stdin", "end"), fixture.backend.commands.map { it.getString("operation") })
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `short execution timeout starts only after readiness and still terminates program`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val request = JSONObject(spawnRequest()).apply {
                getJSONObject("arguments").getJSONObject("options").put("timeoutMs", 50)
            }
            val result = JSONObject(fixture.provider.invoke(request.toString()))
            val publication = result.getJSONArray("resources").getJSONObject(0)
            val bindingId = publication.getString("bindingId")
            val resourceId = publication.getJSONObject("processInstance").getString("processResourceId")
            val timeout = CountDownLatch(1)
            fixture.provider.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink {
                val event = JSONObject(it)
                if (event.getString("event") == "error" &&
                    event.getJSONArray("tuple").getJSONObject(0).getString("code") == "ETIMEDOUT"
                ) timeout.countDown()
            })?.use {
                assertFalse(timeout.await(100, TimeUnit.MILLISECONDS))
                assertTrue(fixture.backend.commands.isEmpty())
                readiness.complete(Unit)
                assertTrue(fixture.backend.spawnSubmittedLatch.await(1, TimeUnit.SECONDS))
                assertTrue(timeout.await(1, TimeUnit.SECONDS))
                fixture.provider.emit(spawnEvent(fixture.environmentId(), resourceId))
                assertEquals("SIGKILL", fixture.backend.commands.last().getString("signal"))
            }
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `startup cancellation settles queued stdin callbacks exactly once`() {
        val readiness = CompletableFuture<Unit>()
        val fixture = fixture(FakeBackend(readiness = readiness))
        try {
            val result = JSONObject(fixture.provider.invoke(spawnRequest()))
            val publications = result.getJSONArray("resources")
            val childBindingId = publications.getJSONObject(0).getString("bindingId")
            val stdinBindingId = publications.getJSONObject(1).getString("bindingId")
            val events = mutableListOf<JSONObject>()
            fixture.provider.subscribeResource(stdinBindingId, RuntimeCapabilityResourceEventSink { events += JSONObject(it) })?.use {
                assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "write", 1))).getBoolean("ok"))
                assertTrue(JSONObject(fixture.provider.invoke(stdinRequest(stdinBindingId, "end", 2))).getBoolean("ok"))
                fixture.provider.invoke(signalRequest(childBindingId, "SIGKILL"))
                fixture.provider.invoke(signalRequest(childBindingId, "SIGKILL"))
                readiness.complete(Unit)
            }
            assertEquals(listOf(1L, 2L), events.filter { it.getString("event") == "callback" }.map { it.getLong("callbackId") })
            assertTrue(events.filter { it.getString("event") == "callback" }.all { it.has("error") })
            assertEquals(1, events.count { it.getString("event") == "close" })
            assertTrue(fixture.backend.commands.isEmpty())
            assertEquals(1, fixture.backend.closeCount.get())
        } finally {
            fixture.provider.close()
            fixture.manager.close()
        }
    }

    @Test
    fun `known ready spawn registers timeout atomically with close`() {
        val fixture = fixture(FakeBackend())
        val scheduler = HoldingTimeoutExecutor()
        // A test-only scheduler pauses precisely before schedule returns its Future.
        val field = AndroidV86ProcessProvider::class.java.getDeclaredField("timeoutExecutor").apply { isAccessible = true }
        (field.get(fixture.provider) as java.util.concurrent.ScheduledExecutorService).shutdownNow()
        field.set(fixture.provider, scheduler)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val invocation = executor.submit<String> { fixture.provider.invoke(spawnRequest()) }
            assertTrue(scheduler.scheduling.await(1, TimeUnit.SECONDS))
            val closing = executor.submit<Unit> {
                fixture.provider.emit(JSONObject().put("event", "backend-error").put("environmentId", fixture.environmentId()))
            }
            assertTrue(fixture.backend.closedLatch.await(1, TimeUnit.SECONDS))
            // close has reached state teardown; it must wait for timeout ownership to be published.
            assertTrue(runCatching { closing.get(100, TimeUnit.MILLISECONDS) }.exceptionOrNull() is java.util.concurrent.TimeoutException)
            scheduler.releaseSchedule.countDown()
            assertTrue(JSONObject(invocation.get(1, TimeUnit.SECONDS)).getBoolean("ok"))
            closing.get(1, TimeUnit.SECONDS)
            assertTrue(scheduler.scheduled.get().isCancelled)
            assertEquals(1, fixture.backend.closeCount.get())
            assertTrue(fixture.manager.activeEnvironmentIds().isEmpty())
        } finally {
            scheduler.releaseSchedule.countDown()
            executor.shutdownNow()
            fixture.provider.close()
            fixture.manager.close()
            scheduler.shutdownNow()
        }
    }

    private fun fixture(
        backend: FakeBackend,
        networkTransport: AndroidV86NetworkTransport? = null,
        policy: JSONObject = processPolicy(),
        startupTimeoutMs: Long = 1_000,
    ): Fixture {
        val manager = AndroidV86EnvironmentManager(
            processId = "runtime-process",
            generation = 7,
            defaultScope = "processTree",
            startupTimeoutMs = startupTimeoutMs,
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

    private fun stdinRequest(bindingId: String, member: String, callbackId: Long?) = JSONObject()
        .put("arguments", if (member == "write") "payload" else JSONObject())
        .put("inheritedBindingId", bindingId)
        .put("member", "ChildProcess.stdin.$member")
        .put("operation", "process.stdin.$member")
        .apply { callbackId?.let { put("providerData", JSONObject().put("callbackId", it)) } }
        .put("resource", JSONObject().put("kind", "processInstance"))
        .toString()

    private fun stdinEvent(environmentId: String, event: String, command: JSONObject) = JSONObject()
        .put("callbackId", command.optLong("callbackId", -1).takeIf { it > 0 } ?: JSONObject.NULL)
        .put("environmentId", environmentId)
        .put("event", event)
        .put("operation", command.getString("operation"))
        .put("processId", command.getInt("processId"))
        .put("stdinSequence", command.getLong("stdinSequence"))

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
        private val failOperation: String? = null,
        private val readiness: CompletableFuture<Unit> = CompletableFuture.completedFuture(Unit),
    ) : AndroidV86EnvironmentBackend {
        val closeCount = AtomicInteger()
        val closedLatch = CountDownLatch(1)
        val spawnSubmittedLatch = CountDownLatch(1)
        val commands = mutableListOf<JSONObject>()
        lateinit var environmentId: String

        override fun start(host: RuntimeTrustedBackendHost) = readiness

        @Synchronized
        open override fun submit(command: JSONObject) {
            commands += JSONObject(command.toString())
            if (command.getString("operation") == "spawn") spawnSubmittedLatch.countDown()
            if (failSpawn && command.getString("operation") == "spawn") error("spawn failed")
            if (command.getString("operation") == failOperation) error("stdin dispatch failed")
        }

        override fun close() {
            closeCount.incrementAndGet()
            closedLatch.countDown()
        }
    }

    private class HoldingTimeoutExecutor : java.util.concurrent.ScheduledThreadPoolExecutor(1) {
        val scheduling = CountDownLatch(1)
        val releaseSchedule = CountDownLatch(1)
        val scheduled = java.util.concurrent.atomic.AtomicReference<java.util.concurrent.ScheduledFuture<*>>()

        override fun schedule(command: Runnable, delay: Long, unit: TimeUnit): java.util.concurrent.ScheduledFuture<*> {
            scheduling.countDown()
            check(releaseSchedule.await(1, TimeUnit.SECONDS))
            return super.schedule(command, delay, unit).also { scheduled.set(it) }
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
