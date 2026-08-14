package ai.oneworks.holonomy.e2e

import ai.oneworks.holonomy.host.RuntimeTrustedBackend
import ai.oneworks.holonomy.host.RuntimeTrustedBackendChannel
import ai.oneworks.holonomy.host.RuntimeTrustedBackendHost
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** E2E-only Backend that proves the production trusted channel and generation fence. */
internal class E2eTrustedBackend(
    private val runtimeId: String,
    private val generation: Long,
) : RuntimeTrustedBackend {
    private lateinit var host: RuntimeTrustedBackendHost

    override fun start(host: RuntimeTrustedBackendHost) {
        this.host = host
        invoke { terminal -> E2eTrustedBackendEvidence.started(runtimeId, generation, terminal) }
    }

    override fun close() {
        if (!::host.isInitialized) return
        invoke { terminal -> E2eTrustedBackendEvidence.closed(runtimeId, generation, terminal) }
    }

    private fun invoke(terminal: (String) -> Unit) {
        host.invoke(
            RuntimeTrustedBackendChannel.LINUX_FILESYSTEM,
            request().toString(),
            terminal,
        )
    }

    private fun request() = JSONObject()
        .put("environmentId", "$runtimeId:$generation:android-trusted-backend")
        .put("executableId", "android-v86-loader")
        .put("flags", 0x41)
        .put("linuxPid", 41)
        .put("operation", "create")
        .put("path", "/workspace/backend-loader.txt")
        .put("policy", e2eTrustedBackendProcessPolicy())
        .put("processId", 9)
        .put("processResourceId", "android-v86-loader-process")
        .put("scope", "runtime")
}

internal fun e2eTrustedBackendProcessPolicy() = JSONObject()
    .put("access", "sandboxed")
    .put("environment", JSONObject().put("allowedNames", JSONArray()).put("maxValueBytes", 1))
    .put(
        "executables",
        JSONArray().put(
            JSONObject()
                .put("argumentBytes", 4_096)
                .put("executableId", "android-v86-selftest"),
        ),
    )
    .put(
        "limits",
        JSONObject()
            .put("maxConcurrentProcesses", 1)
            .put("maxExecutionTimeMs", 120_000)
            .put("maxOpenPipes", 3)
            .put("maxProcessTreeDepth", 1)
            .put("maxStderrBytes", 4_096)
            .put("maxStdinBytes", 4_096)
            .put("maxStdoutBytes", 65_536)
            .put("maxTotalProcesses", 2)
            .put("maxWritableRootfsBytes", 4_096),
    )
    .put(
        "mounts",
        JSONArray().put(
            JSONObject()
                .put("guestPath", "/workspace")
                .put("rights", JSONArray().put("read").put("write"))
                .put("rootId", "workspace"),
        ),
    )
    .put(
        "network",
        JSONObject()
            .put("access", "restricted")
            .put(
                "endpoints",
                JSONArray().put(
                    JSONObject()
                        .put("hostname", "127.0.0.1")
                        .put("ports", JSONArray().put(E2E_PROCESS_NETWORK_PORT))
                        .put("transport", "tcp"),
                ),
            )
            .put("maxSockets", 1),
    )
    .put("shell", JSONObject().put("access", "none"))

internal const val E2E_PROCESS_NETWORK_PORT = 18_086

internal object E2eTrustedBackendEvidence {
    private val closeLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val closeTerminals = ConcurrentHashMap<String, String>()
    private val startLatches = ConcurrentHashMap<String, CountDownLatch>()
    private val startTerminals = ConcurrentHashMap<String, String>()

    fun started(runtimeId: String, generation: Long, terminal: String) {
        val key = key(runtimeId, generation)
        startTerminals[key] = terminal
        startLatches.computeIfAbsent(key) { CountDownLatch(1) }.countDown()
    }

    fun closed(runtimeId: String, generation: Long, terminal: String) {
        val key = key(runtimeId, generation)
        closeTerminals[key] = terminal
        closeLatches.computeIfAbsent(key) { CountDownLatch(1) }.countDown()
    }

    fun awaitStarted(runtimeId: String, generation: Long, timeoutMinutes: Long = 2): JSONObject =
        await(key(runtimeId, generation), startLatches, startTerminals, timeoutMinutes)

    fun awaitClosed(runtimeId: String, generation: Long): JSONObject =
        await(key(runtimeId, generation), closeLatches, closeTerminals, 2)

    private fun await(
        key: String,
        latches: ConcurrentHashMap<String, CountDownLatch>,
        terminals: ConcurrentHashMap<String, String>,
        timeoutMinutes: Long,
    ): JSONObject {
        val latch = latches.computeIfAbsent(key) { CountDownLatch(1) }
        check(latch.await(timeoutMinutes, TimeUnit.MINUTES)) { "Timed out waiting for trusted Backend evidence" }
        return JSONObject(checkNotNull(terminals[key]))
    }

    private fun key(runtimeId: String, generation: Long) = "$runtimeId:$generation"
}
