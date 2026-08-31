package ai.oneworks.holonomy.e2e.session.capability

import android.os.SystemClock
import ai.oneworks.holonomy.capability.AndroidCapabilityHost
import ai.oneworks.holonomy.capability.AndroidDeviceObservationSource
import ai.oneworks.holonomy.capability.AndroidDeviceValueSource
import ai.oneworks.holonomy.e2e.session.supervisor.SessionSupervisorInstrumentationHarness
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import ai.oneworks.holonomy.v86.AndroidV86AssetStore
import ai.oneworks.holonomy.session.RuntimeId
import ai.oneworks.holonomy.session.SessionControlOperation
import ai.oneworks.holonomy.session.SessionIsolation
import ai.oneworks.holonomy.session.SessionModuleSpec
import ai.oneworks.holonomy.session.SessionOutputEvent
import ai.oneworks.holonomy.session.SessionRuntimePhase
import ai.oneworks.holonomy.session.SessionRuntimePluginBundle
import ai.oneworks.holonomy.session.SessionRuntimePluginFile
import ai.oneworks.holonomy.session.SessionRuntimeSpec
import ai.oneworks.holonomy.session.StatusRuntimeCommand
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.session.SessionSandboxNetworkPolicy
import ai.oneworks.holonomy.session.SessionSandboxPolicy
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CapabilityRuntimeKernelInstrumentationTest {
    @Test
    fun publicV86ChildProcessEventsReachGuestFacade() {
        val available = AndroidV86AssetStore(targetContext().assets).available
        if (InstrumentationRegistry.getArguments().getString("holonomyRequireV86") == "true") {
            assertTrue("The required v86 production assets were not packaged", available)
        }
        assumeTrue("The optional v86 production assets were not packaged", available)
        val fixture = fixture()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val network = V86NetworkFixtureServer()
        val runtimeId = harness.runtimeId("capability-v86-events")
        try {
            assertTrue(harness.create(runtimeId, runtimeSpec(fixture, runtimeId)).ack.accepted)
            assertTrue(harness.start(runtimeId, V86_START_TIMEOUT_SECONDS).ack.accepted)
            val output = harness.awaitOutput(
                runtimeId,
                "public v86 Process/Linux conformance",
                V86_OUTPUT_TIMEOUT_SECONDS,
            ) { snapshot ->
                snapshot.events.any { event ->
                    event.generation == 1L &&
                        event.chunk.contains("V86_CONFORMANCE_EVENT:process-control:timeout-abort-flow:ok")
                }
            }
            val trace = output.events.filter { event ->
                event.generation == 1L && event.chunk.contains("V86_CONFORMANCE_EVENT:")
            }.joinToString(separator = "") { event -> event.chunk }
            for (
                marker in listOf(
                    "V86_CONFORMANCE_EVENT:child:spawn:0",
                    "V86_CONFORMANCE_EVENT:stdout:data",
                    "V86_CONFORMANCE_EVENT:child:exit:2",
                    "V86_CONFORMANCE_EVENT:child:close:2",
                    "V86_CONFORMANCE_EVENT:callback:3:ok",
                    "V86_CONFORMANCE_EVENT:scope:process-tree-shell:ok",
                    "V86_CONFORMANCE_EVENT:network:tcp-udp:ok",
                    "V86_CONFORMANCE_EVENT:capability:device-system:ok",
                    "V86_CONFORMANCE_EVENT:descendant:allow-deny:ok",
                    "V86_CONFORMANCE_EVENT:process-control:timeout-abort-flow:ok",
                )
            ) assertTrue("missing $marker in $trace", trace.contains(marker))
        } finally {
            network.close()
            harness.close()
        }
    }

    @Test
    fun restartClosesOldFilesystemWatcherBeforeGenerationTwo() {
        val fixture = targetContext().assets.open(FILESYSTEM_GENERATION_FIXTURE_ASSET)
            .bufferedReader().use { JSONObject(it.readText()) }
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("filesystem-generation")
        try {
            assertTrue(harness.create(runtimeId, runtimeSpec(fixture, runtimeId)).ack.accepted)
            assertTrue(harness.start(runtimeId).ack.accepted)
            harness.awaitOutput(runtimeId, "generation-one filesystem watcher") { snapshot ->
                snapshot.events.any { event ->
                    event.generation == 1L && event.chunk.contains(FILESYSTEM_GENERATION_READY)
                }
            }
            val restarted = harness.execute(
                ai.oneworks.holonomy.session.RestartRuntimeCommand(
                    runtimeId,
                    harness.commandId(),
                    expectedGeneration = 1,
                ),
            )
            assertTrue(restarted.ack.accepted)
            harness.track(runtimeId, 2)
            harness.awaitOutput(runtimeId, "generation-two filesystem watcher") { snapshot ->
                snapshot.events.any { event ->
                    event.generation == 2L && event.chunk.contains(FILESYSTEM_GENERATION_READY)
                }
            }
            val workspace = File(targetContext().filesDir, "capability-workspaces/${runtimeId.value}")
            File(workspace, "generation-watch/after-restart.txt").writeText("generation-two")
            val output = harness.awaitOutput(runtimeId, "generation-two filesystem event") { snapshot ->
                snapshot.events.any { event ->
                    event.generation == 2L && event.chunk.contains(FILESYSTEM_GENERATION_EVENT)
                }
            }
            assertFalse(output.events.any { event ->
                event.generation == 1L && event.chunk.contains(FILESYSTEM_GENERATION_EVENT)
            })
        } finally {
            harness.close()
        }
    }

    @Test
    fun productionDeviceProviderPublishesRealPowerRevisionAndFencesRelease() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("dumpsys battery unplug").close()
        val session = fixture().getJSONObject("capabilityRuntime")
        val processId = "android-device-platform-${System.nanoTime()}"
        session.put("processId", processId)
        val envelope = JSONObject().put("generation", 1).put("session", session)
        val networkProvider = session.getJSONObject("providerConfiguration").getString("networkProvider")
        val values = AndroidDeviceValueSource.platform(targetContext())
        val initial = (values.value("device.power.read") as JSONObject).optInt("levelPercent", -1)
        val target = if (initial == 42) 41 else 42
        val host = AndroidCapabilityHost(targetContext(), envelope.toString(), processId, 1, networkProvider)
        val events = CopyOnWriteArrayList<JSONObject>()
        val latch = CountDownLatch(1)
        var bindingId: String? = null
        var subscription: AutoCloseable? = null
        try {
            val admitted = JSONObject(host.invokeSync(deviceSubscriptionRequest("power")))
            assertTrue(admitted.toString(), admitted.getBoolean("ok"))
            bindingId = admitted.getJSONObject("value").getJSONObject("binding").getString("bindingId")
            subscription = host.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink { source ->
                val event = JSONObject(source)
                events += event
                if (event.getString("phase") == "change") latch.countDown()
            })
            assertTrue(subscription != null)
            assertEquals("snapshot", events.single().getString("phase"))
            val baselineRevision = events.single().getJSONObject("reading").getLong("revision")
            assertFalse("Sticky battery state must not be reported as a change", latch.await(250, TimeUnit.MILLISECONDS))
            instrumentation.uiAutomation.executeShellCommand("dumpsys battery set level $target").close()
            assertTrue("Power Provider did not publish the platform change", latch.await(5, TimeUnit.SECONDS))
            val change = events.first { event -> event.getString("phase") == "change" }
            val changeReading = change.getJSONObject("reading")
            assertTrue(changeReading.getLong("revision") > baselineRevision)
            assertEquals(target, changeReading.getJSONObject("value").getInt("levelPercent"))
            val current = JSONObject(host.invokeSync(deviceReadRequest("device.power.read")))
                .getJSONObject("value")
            assertEquals(changeReading.getLong("revision"), current.getLong("revision"))
            assertEquals(target, current.getJSONObject("value").getInt("levelPercent"))

            val countBeforeRelease = events.size
            host.releaseResource(requireNotNull(bindingId))
            instrumentation.uiAutomation.executeShellCommand("dumpsys battery set level ${if (target == 42) 41 else 42}").close()
            SystemClock.sleep(250)
            assertEquals(countBeforeRelease, events.size)
        } finally {
            instrumentation.uiAutomation.executeShellCommand("dumpsys battery reset").close()
            subscription?.close()
            bindingId?.let(host::releaseResource)
            host.close()
        }
    }

    @Test
    fun hostRealmCordisPluginInterceptsCapabilityWithoutSharingGuestGlobals() {
        val fixture = fixture()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("capability-plugin")
        val expectsV86 = AndroidV86AssetStore(targetContext().assets).available
        val network = if (expectsV86) V86NetworkFixtureServer() else null
        try {
            val spec = runtimeSpec(fixture, runtimeId).copy(
                runtimePlugins = listOf(capabilityPluginBundle()),
            )
            assertTrue(harness.create(runtimeId, spec).ack.accepted)
            assertTrue(
                harness.start(
                    runtimeId,
                    if (expectsV86) V86_START_TIMEOUT_SECONDS else FULL_CAPABILITY_OUTPUT_TIMEOUT_SECONDS,
                ).ack.accepted,
            )
            val output = harness.awaitOutput(runtimeId, "Host Realm Capability interceptor") { snapshot ->
                snapshot.events.any { event -> event.chunk.contains(CAPABILITY_PLUGIN_MARKER) }
            }
            assertTrue(output.events.count { event -> event.chunk.contains(CAPABILITY_PLUGIN_MARKER) } >= 1)
            assertKernelResult(awaitResult(harness, runtimeId, 1, expectsV86), expectsV86)
        } finally {
            network?.close()
            harness.close()
        }
    }

    @Test
    fun serviceCompiledSnapshotRunsControlledAndroidCapabilitySliceAndRestart() {
        val fixture = fixture()
        val harness = SessionSupervisorInstrumentationHarness(targetContext())
        val runtimeId = harness.runtimeId("capability-kernel")
        val expectsV86 = AndroidV86AssetStore(targetContext().assets).available
        val network = if (expectsV86) V86NetworkFixtureServer() else null
        try {
            val created = harness.create(runtimeId, runtimeSpec(fixture, runtimeId))
            assertTrue(created.ack.accepted)
            assertEquals(SessionRuntimePhase.CREATED, created.state?.phase)
            val started = harness.start(
                runtimeId,
                if (expectsV86) V86_START_TIMEOUT_SECONDS else FULL_CAPABILITY_OUTPUT_TIMEOUT_SECONDS,
            )
            assertTrue(started.ack.accepted)
            if (started.state?.phase != SessionRuntimePhase.RUNNING) {
                val status = harness.execute(StatusRuntimeCommand(runtimeId, harness.commandId(), 1))
                val evidence = status.output?.events.orEmpty().joinToString(separator = "") { it.chunk }
                assertEquals("output=$evidence result=${status.result}", SessionRuntimePhase.RUNNING, status.state?.phase)
            }
            val first = awaitResult(harness, runtimeId, 1, expectsV86)
            assertKernelResult(first, expectsV86)
            assertFalse(first.toString().contains("android-private-tenant"))
            assertFalse(first.toString().contains("Android Capability Inspector"))
            assertFalse(first.toString().contains("do-not-leak"))
            assertFalse(first.toString().contains("private-hostname"))
            assertFalse(first.toString().contains("Host CPU Secret"))

            val restarted = harness.execute(
                ai.oneworks.holonomy.session.RestartRuntimeCommand(
                    runtimeId,
                    harness.commandId(),
                    expectedGeneration = 1,
                ),
                if (expectsV86) V86_START_TIMEOUT_SECONDS else FULL_CAPABILITY_OUTPUT_TIMEOUT_SECONDS,
            )
            assertTrue(restarted.ack.accepted)
            assertEquals(2L, restarted.ack.generation)
            harness.track(runtimeId, 2)
            assertKernelResult(awaitResult(harness, runtimeId, 2, expectsV86), expectsV86)
        } finally {
            network?.close()
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

    @Test
    fun filesystemResolutionEnforcesSymlinkModeAndRevalidatesTargetIdentity() {
        val session = fixture().getJSONObject("capabilityRuntime")
        val processId = "android-fs-resolution-${System.nanoTime()}"
        session.put("processId", processId)
        session.getJSONObject("runtimeCreation").getJSONObject("configuration")
            .getJSONObject("sandboxPolicy").getJSONObject("filesystem")
            .getJSONArray("roots").getJSONObject(0).put("symlinks", "withinRoot")
        val envelope = JSONObject().put("generation", 1).put("session", session)
        val networkProvider = session.getJSONObject("providerConfiguration").getString("networkProvider")
        val root = File(targetContext().filesDir, "capability-workspaces/$processId")
        val firstTarget = File(root, "target-a.txt")
        val secondTarget = File(root, "target-b.txt")
        val link = File(root, "linked.txt")
        val host = AndroidCapabilityHost(targetContext(), envelope.toString(), processId, 1, networkProvider)
        try {
            root.mkdirs()
            firstTarget.writeText("first")
            secondTarget.writeText("second")
            Files.createSymbolicLink(link.toPath(), firstTarget.toPath())
            val preflight = JSONObject(host.invokeSync(filesystemResolutionRequest("withinRoot", "resolved-1", "preflight")))
            assertTrue(preflight.getBoolean("ok"))
            val admitted = preflight.getJSONObject("value").getJSONArray("requests").getJSONObject(0)
            assertEquals("holo-fs://workspace/target-a.txt", admitted.getString("resolvedVirtualUrl"))

            Files.delete(link.toPath())
            Files.createSymbolicLink(link.toPath(), secondTarget.toPath())
            val verified = JSONObject(host.invokeSync(filesystemResolutionRequest("withinRoot", "resolved-1", "verify")))
            assertTrue(verified.getBoolean("ok"))
            assertEquals("holo-fs://workspace/target-b.txt", verified.getJSONObject("value").getString("resolvedVirtualUrl"))
            assertFalse(admitted.getJSONObject("evidence").getString("targetIdentityDigest") ==
                verified.getJSONObject("value").getJSONObject("evidence").getString("targetIdentityDigest"))

            val denied = JSONObject(host.invokeSync(filesystemResolutionRequest("deny", "resolved-2", "preflight")))
            assertFalse(denied.getBoolean("ok"))
            assertEquals("resource.cross_root", denied.getJSONObject("error").getString("code"))
        } finally {
            host.close()
            Files.deleteIfExists(link.toPath())
            root.deleteRecursively()
        }
    }

    @Test
    fun deviceDisplayObservationAdvancesRevisionAndReleaseFencesLateEvents() {
        val session = fixture().getJSONObject("capabilityRuntime")
        val processId = "android-device-events-${System.nanoTime()}"
        session.put("processId", processId)
        val envelope = JSONObject().put("generation", 1).put("session", session)
        val networkProvider = session.getJSONObject("providerConfiguration").getString("networkProvider")
        var capturedListener: ((String) -> Unit)? = null
        val observationCloseCalls = AtomicInteger()
        val observationSource = AndroidDeviceObservationSource { kinds, listener ->
            assertEquals(setOf("display"), kinds)
            capturedListener = listener
            AutoCloseable { observationCloseCalls.incrementAndGet() }
        }
        var orientation = "portrait"
        val valueSource = AndroidDeviceValueSource { operation ->
            assertEquals("device.display.read", operation)
            JSONObject()
                .put("hdr", "unknown")
                .put("heightCssPx", if (orientation == "portrait") 800 else 400)
                .put("orientation", orientation)
                .put("scale", 2.0)
                .put("wideColor", "unknown")
                .put("widthCssPx", if (orientation == "portrait") 400 else 800)
        }
        val host = AndroidCapabilityHost(
            targetContext(),
            envelope.toString(),
            processId,
            1,
            networkProvider,
            deviceObservationSource = observationSource,
            deviceValueSource = valueSource,
        )
        val events = CopyOnWriteArrayList<JSONObject>()
        var bindingId: String? = null
        try {
            val admitted = JSONObject(host.invokeSync(deviceSubscriptionRequest("display")))
            assertTrue(admitted.toString(), admitted.getBoolean("ok"))
            bindingId = admitted.getJSONObject("value").getJSONObject("binding").getString("bindingId")
            val subscription = host.subscribeResource(bindingId, RuntimeCapabilityResourceEventSink { source ->
                val event = JSONObject(source)
                events += event
            })
            assertTrue(subscription != null)
            assertEquals("snapshot", events.single().getString("phase"))
            val baselineRevision = events.single().getJSONObject("reading").getLong("revision")

            orientation = "landscape"
            capturedListener?.invoke("display")
            val change = events.first { event -> event.getString("phase") == "change" }
            assertTrue(change.getJSONObject("reading").getLong("revision") > baselineRevision)

            val countBeforeRelease = events.size
            host.releaseResource(bindingId)
            assertEquals(1, observationCloseCalls.get())
            orientation = "portrait"
            capturedListener?.invoke("display")
            assertEquals(countBeforeRelease, events.size)
            subscription?.close()
        } finally {
            bindingId?.let(host::releaseResource)
            host.close()
        }
    }

    private fun assertKernelResult(result: JSONObject, expectsV86: Boolean) {
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
        val deviceM3 = result.getJSONObject("deviceM3")
        for (name in listOf("cellular", "connectivity", "display", "input", "lifecycle", "wifi")) {
            assertEquals("available", deviceM3.getJSONObject(name).getString("status"))
        }
        val summary = deviceM3.getJSONObject("summary")
        val summaryPromise = deviceM3.getJSONObject("summaryPromise")
        assertEquals(summary.getInt("schemaVersion"), summaryPromise.getInt("schemaVersion"))
        for (name in listOf("display", "formFactor", "input", "lifecycle", "power")) {
            val syncReading = summary.getJSONObject(name)
            val promiseReading = summaryPromise.getJSONObject(name)
            assertTrue(promiseReading.getLong("observedAt") >= syncReading.getLong("observedAt"))
            syncReading.remove("observedAt")
            promiseReading.remove("observedAt")
            assertEquals(syncReading.toString(), promiseReading.toString())
        }
        val deviceEvents = deviceM3.getJSONArray("events")
        assertEquals(4, deviceEvents.length())
        assertEquals("[\"connectivity\",\"display\",\"lifecycle\",\"power\"]", JSONArray().apply {
            for (index in 0 until deviceEvents.length()) put(deviceEvents.getJSONObject(index).getString("kind"))
        }.toString())
        assertEquals("holo.invalid_arguments", deviceM3.getString("invalidResyncCode"))
        assertEquals(1, deviceM3.getInt("maxQueuedEvents"))
        val deviceOverflow = deviceM3.getJSONObject("overflow")
        assertEquals("overflow", deviceOverflow.getString("kind"))
        assertEquals(4, deviceOverflow.getJSONObject("requiredRevisions").length())
        val filesystemM3 = result.getJSONObject("filesystemM3")
        assertEquals("ENOENT", filesystemM3.getString("abortedWriteCode"))
        assertEquals("before", filesystemM3.getString("atomicRollback"))
        assertEquals("EFBIG", filesystemM3.getString("byteLimitCode"))
        assertEquals("ABORT_ERR", filesystemM3.getJSONObject("callbackAbort").getString("code"))
        assertEquals("AbortError", filesystemM3.getJSONObject("callbackAbort").getString("name"))
        assertEquals(1, filesystemM3.getJSONObject("callbackAbort").getInt("args"))
        assertEquals(1, filesystemM3.getInt("callbackAbortCalls"))
        assertEquals("callback-open", filesystemM3.getString("callbackFdText"))
        assertTrue(filesystemM3.getBoolean("callbackMetadata"))
        assertTrue(filesystemM3.getJSONArray("callbackReaddir").toString().contains("opened.txt"))
        val callbackArities = filesystemM3.getJSONArray("callbackArities")
        assertEquals("[2,2,1,2,2,2,1,1]", callbackArities.toString())
        assertEquals("handle-before", filesystemM3.getString("fdText"))
        assertEquals("fd-write", filesystemM3.getString("fdWriteText"))
        assertEquals("EEXIST", filesystemM3.getString("exclusiveCode"))
        assertEquals("handle-before", filesystemM3.getString("handleRead"))
        assertEquals("EMFILE", filesystemM3.getString("handleLimitCode"))
        assertEquals("promise-value", filesystemM3.getString("promiseText"))
        assertTrue(filesystemM3.getBoolean("promiseFile"))
        assertTrue(filesystemM3.getBoolean("promiseLstat"))
        assertEquals("ABORT_ERR", filesystemM3.getJSONObject("promiseAbort").getString("code"))
        assertEquals("AbortError", filesystemM3.getJSONObject("promiseAbort").getString("name"))
        assertTrue(filesystemM3.getJSONArray("promiseDirectory").toString().contains("listed.txt"))
        assertEquals("EBADF", filesystemM3.getString("staleFdCode"))
        assertEquals("[\"undefined\",\"undefined\",\"undefined\"]", filesystemM3
            .getJSONArray("unsupportedExports").toString())
        assertTrue(filesystemM3.getBoolean("lstatFile"))
        assertEquals(12, filesystemM3.getLong("handleSize"))
        if (!filesystemM3.isNull("directory")) {
            assertTrue(filesystemM3.getString("directory").startsWith("holo-fs://workspace/m3"))
        }
        assertTrue(filesystemM3.getJSONArray("names").toString().contains("renamed.txt"))
        assertTrue(filesystemM3.getJSONArray("dirents").toString().contains("renamed.txt"))
        val watchEvent = filesystemM3.getJSONObject("watchEvent")
        assertTrue(watchEvent.getString("type") in setOf("change", "rename"))
        assertEquals("watched.txt", watchEvent.getString("filename"))
        assertEquals(1, watchEvent.getInt("maxQueuedEvents"))
        val iteratorEvent = filesystemM3.getJSONObject("iteratorEvent")
        assertTrue(iteratorEvent.getString("eventType") in setOf("change", "rename"))
        assertEquals("iterator.txt", iteratorEvent.getString("filename"))
        assertEquals(1, filesystemM3.getInt("iteratorMaxQueuedEvents"))
        assertTrue(filesystemM3.getBoolean("iteratorDone"))
        assertEquals("ABORT_ERR", filesystemM3.getJSONObject("writeAbort").getString("code"))
        assertEquals("AbortError", filesystemM3.getJSONObject("writeAbort").getString("name"))
        val conformance = result.getJSONObject("guestConformance")
        val expectedTests = if (expectsV86) 13 else 7
        assertEquals(0, conformance.getInt("failed"))
        assertEquals(expectedTests, conformance.getInt("passed"))
        assertEquals(expectedTests, conformance.getInt("total"))
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

    private fun awaitResult(
        harness: SessionSupervisorInstrumentationHarness,
        runtimeId: RuntimeId,
        generation: Long,
        expectsV86: Boolean,
    ): JSONObject {
        val output = runCatching {
            harness.awaitOutput(
                runtimeId,
                "M2.5 Android capability output",
                if (expectsV86) V86_OUTPUT_TIMEOUT_SECONDS else FULL_CAPABILITY_OUTPUT_TIMEOUT_SECONDS,
            ) { snapshot ->
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
        val moduleArray = fixture.getJSONArray("modules")
        return SessionRuntimeSpec(
            entryUrl = entryUrl,
            modules = List(moduleArray.length()) { index ->
                val module = moduleArray.getJSONObject(index)
                SessionModuleSpec(module.getString("url"), module.getString("source"))
            },
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

    private fun capabilityPluginBundle() = SessionRuntimePluginBundle(
        schemaVersion = 1,
        instanceId = "android-capability",
        rootUrl = "holo-plugins:///android-capability/",
        entryUrl = CAPABILITY_PLUGIN_URL,
        exportName = "default",
        configJson = "{}",
        bundleSha256 = CAPABILITY_PLUGIN_BUNDLE_SHA256,
        files = listOf(
            SessionRuntimePluginFile(
                CAPABILITY_PLUGIN_URL,
                CAPABILITY_PLUGIN_SOURCE,
                CAPABILITY_PLUGIN_FILE_SHA256,
            ),
        ),
    )

    private fun filesystemResolutionRequest(mode: String, requestId: String, phase: String): String {
        val limits = JSONObject()
            .put("maxDirectoryEntries", 32)
            .put("maxOpenHandles", 8)
            .put("maxQueuedEvents", 8)
            .put("maxReadBytes", 4096)
            .put("maxWatchers", 2)
            .put("maxWriteBytes", 4096)
        val root = JSONObject()
            .put("rights", JSONArray().put("read"))
            .put("rootId", "workspace")
            .put("symlinks", mode)
            .put("virtualPrefixes", JSONArray().put("holo-fs://workspace/"))
        val binding = JSONObject()
            .put("providerModule", "host.fs")
            .put("constraints", JSONObject().put("limits", limits).put("roots", JSONArray().put(root)))
        return JSONObject()
            .put("arguments", JSONObject().put("path", "holo-fs://workspace/linked.txt"))
            .put("authorityBindings", JSONArray().put(binding))
            .put("generation", 1)
            .put("invocationBinding", JSONObject())
            .put("invocationMode", "sync")
            .put("member", "readFileSync")
            .put("module", "node:fs")
            .put("operation", "filesystem.file.read")
            .put("providerModule", "host.fs")
            .put("providerPhase", phase)
            .put("requestId", requestId)
            .put(
                "resource",
                JSONObject()
                    .put("kind", "filesystem")
                    .put("pathSegments", JSONArray().put("linked.txt"))
                    .put("rootId", "workspace"),
            )
            .apply { if (phase == "verify") put("resolutionIndex", 0) }
            .toString()
    }

    private fun deviceSubscriptionRequest(kind: String): String {
        val constraints = JSONObject()
            .put("kinds", JSONArray().put(kind))
            .put("maxQueuedEvents", 8)
            .put("operations", JSONArray().put("device.events.subscribe").put("device.$kind.read"))
        return JSONObject()
            .put("arguments", JSONObject().put("kinds", JSONArray().put(kind)))
            .put(
                "authorityBindings",
                JSONArray().put(
                    JSONObject()
                        .put("capabilityName", "host.device.events")
                        .put("constraints", constraints)
                        .put("providerModule", "host.device"),
                ),
            )
            .put("generation", 1)
            .put("invocationBinding", JSONObject())
            .put("invocationMode", "promise")
            .put("member", "subscribe")
            .put("module", "holo:device/promises")
            .put("operation", "device.events.subscribe")
            .put("providerModule", "host.device")
            .put("requestId", "device-events-${System.nanoTime()}")
            .put(
                "resource",
                JSONObject()
                    .put("kind", "deviceField")
                    .put("operation", "device.events.subscribe"),
            )
            .toString()
    }

    private fun deviceReadRequest(operation: String): String = JSONObject()
        .put("arguments", JSONObject())
        .put(
            "authorityBindings",
            JSONArray().put(
                JSONObject()
                    .put("capabilityName", "host.device.state")
                    .put("constraints", JSONObject().put("operations", JSONArray().put(operation)))
                    .put("providerModule", "host.device"),
            ),
        )
        .put("generation", 1)
        .put("invocationBinding", JSONObject())
        .put("invocationMode", "sync")
        .put("member", "getPower")
        .put("module", "holo:device")
        .put("operation", operation)
        .put("providerModule", "host.device")
        .put("providerPhase", "execute")
        .put("requestId", "device-read-${System.nanoTime()}")
        .put("resource", JSONObject().put("kind", "deviceField").put("operation", operation))
        .toString()

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
        private const val FULL_CAPABILITY_OUTPUT_TIMEOUT_SECONDS = 60L
        private const val V86_OUTPUT_TIMEOUT_SECONDS = 240L
        private const val V86_START_TIMEOUT_SECONDS = 360L
        private const val FIXTURE_ASSET = "runtime/capability-kernel-v1.json"
        private const val FILESYSTEM_GENERATION_FIXTURE_ASSET =
            "runtime/capability-filesystem-generation-v1.json"
        private const val FILESYSTEM_GENERATION_EVENT = "M3_FS_GENERATION_EVENT"
        private const val FILESYSTEM_GENERATION_READY = "M3_FS_GENERATION_READY"
        private const val CAPABILITY_PLUGIN_BUNDLE_SHA256 =
            "4a3749489ef18fb9a1856553b2527baf0be45628c383b52190de66ad1dece72a"
        private const val CAPABILITY_PLUGIN_FILE_SHA256 =
            "23674def53a3192fc21a97b0a9c6fe46944905223cbbb26c4cc0f624c59f96b7"
        private const val CAPABILITY_PLUGIN_MARKER = "ANDROID_CAPABILITY_PLUGIN:system.os.arch.read"
        private const val CAPABILITY_PLUGIN_SOURCE =
            "export default ctx => { globalThis.pluginRealmOnly = 'host'; " +
                "ctx.holo.intercept({ module: 'node:os', member: 'arch' }, (invocation, next) => { " +
                "console.log('ANDROID_CAPABILITY_PLUGIN:' + invocation.operation); return next() }) }"
        private const val CAPABILITY_PLUGIN_URL = "holo-plugins:///android-capability/index.mjs"
        private const val MOCK_ORIGIN = "https://mock.example"
        private const val NETWORK_RULES_REPLACE = "network.rules.replace"
        private const val OUTPUT_MARKER = "M25_ANDROID:"
    }

    private class V86NetworkFixtureServer : AutoCloseable {
        private val closed = java.util.concurrent.atomic.AtomicBoolean(false)
        private val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>()
        private val tcp = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress("127.0.0.1", V86_TCP_PORT))
            soTimeout = SOCKET_POLL_TIMEOUT_MS
        }
        private val udp = DatagramSocket(null).apply {
            reuseAddress = true
            bind(InetSocketAddress("127.0.0.1", V86_UDP_PORT))
            soTimeout = SOCKET_POLL_TIMEOUT_MS
        }
        private val tcpThread = worker("holonomy-v86-test-tcp", ::serveTcp)
        private val udpThread = worker("holonomy-v86-test-udp", ::serveUdp)

        override fun close() {
            closed.set(true)
            runCatching(tcp::close)
            runCatching(udp::close)
            tcpThread.join(SERVER_CLOSE_TIMEOUT_MS)
            udpThread.join(SERVER_CLOSE_TIMEOUT_MS)
            failure.get()?.let { error -> throw AssertionError("v86 network fixture server failed", error) }
        }

        private fun serveTcp() {
            while (!closed.get()) {
                try {
                    tcp.accept().use { socket ->
                        val input = socket.getInputStream()
                        var matched = 0
                        var total = 0
                        val terminator = byteArrayOf(13, 10, 13, 10)
                        while (matched < terminator.size && total < MAX_HTTP_HEADER_BYTES) {
                            val byte = input.read()
                            if (byte < 0) break
                            total += 1
                            matched = if (byte.toByte() == terminator[matched]) matched + 1
                            else if (byte.toByte() == terminator[0]) 1 else 0
                        }
                        val body = "HOLO_ANDROID_V86_TCP_OK".toByteArray()
                        socket.getOutputStream().write(
                            "HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                                .toByteArray(),
                        )
                        socket.getOutputStream().write(body)
                        socket.getOutputStream().flush()
                    }
                } catch (_: SocketTimeoutException) {
                    // Poll the generation-owned close flag.
                } catch (error: Throwable) {
                    if (!closed.get()) {
                        failure.compareAndSet(null, error)
                        closed.set(true)
                    }
                }
            }
        }

        private fun serveUdp() {
            val bytes = ByteArray(2_048)
            while (!closed.get()) {
                try {
                    val request = DatagramPacket(bytes, bytes.size)
                    udp.receive(request)
                    val prefix = "HOLO_ANDROID_V86_UDP_OK:".toByteArray()
                    val response = prefix + request.data.copyOfRange(request.offset, request.offset + request.length)
                    udp.send(DatagramPacket(response, response.size, request.socketAddress))
                } catch (_: SocketTimeoutException) {
                    // Poll the generation-owned close flag.
                } catch (error: Throwable) {
                    if (!closed.get()) {
                        failure.compareAndSet(null, error)
                        closed.set(true)
                    }
                }
            }
        }

        private fun worker(name: String, action: () -> Unit) = Thread(action, name).apply {
            isDaemon = true
            start()
        }

        private companion object {
            private const val MAX_HTTP_HEADER_BYTES = 64 * 1024
            private const val SERVER_CLOSE_TIMEOUT_MS = 2_000L
            private const val SOCKET_POLL_TIMEOUT_MS = 500
            private const val V86_TCP_PORT = 18088
            private const val V86_UDP_PORT = 18089
        }
    }
}
