package ai.oneworks.holonomy.v86

import android.util.Log
import ai.oneworks.holonomy.capability.AndroidProcessCapabilityProvider
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/** Android Provider for the asynchronous Node child_process facade backed by v86/Linux. */
class AndroidV86ProcessProvider internal constructor(
    private val generation: Long,
    private val policy: JSONObject,
    profile: JSONObject,
    private val backend: AndroidV86EnvironmentManager,
    private val networkTransport: AndroidV86NetworkTransport? = null,
    private val diagnostics: Boolean = false,
) : AndroidProcessCapabilityProvider, AndroidV86ProcessEventSink {
    private val closed = AtomicBoolean(false)
    private val executables = parseExecutables(profile)
    private val lifecycleLock = Any()
    private val nextId = AtomicInteger(1)
    private val networkPreflights = ConcurrentHashMap<String, ProcessNetworkResolution>()
    private val processLimitLock = Any()
    private val resources = ConcurrentHashMap<String, AndroidV86ProcessState>()
    private val processes = ConcurrentHashMap<String, AndroidV86ProcessState>()
    private val processesByBackendId = ConcurrentHashMap<String, AndroidV86ProcessState>()
    private val timeoutExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "holonomy-v86-process-timeout").apply { isDaemon = true }
    }
    private var totalProcessStarts = 0

    override fun invoke(requestJson: String): String = runCatching {
        check(!closed.get())
        val request = JSONObject(requestJson)
        if (request.getString("member") == "authorizeDescendantProcess") {
            return@runCatching authorizeDescendant(request)
        }
        val resource = request.getJSONObject("resource")
        when (resource.getString("kind")) {
            "processExecutable" -> spawn(request, resource)
            "processInstance" -> invokeResource(request)
            "processNetworkEndpoint" -> authorizeNetwork(request, resource)
            else -> failure("resource.invalid")
        }
    }.getOrElse { error ->
        diagnostic("provider invocation failed type=${error.javaClass.simpleName}")
        failure("provider.unavailable")
    }

    override fun ownsResource(bindingId: String): Boolean = resources.containsKey(bindingId)

    override fun subscribeResource(bindingId: String, sink: RuntimeCapabilityResourceEventSink): AutoCloseable? =
        resources[bindingId]?.channel(bindingId)?.subscribe(sink).also {
            diagnostic("subscribed resource $bindingId available=${it != null}")
        }

    override fun releaseResource(bindingId: String) {
        val state = resources.remove(bindingId) ?: return
        state.channel(bindingId)?.close()
        if (bindingId == state.childBindingId && !state.closed) signal(state, "SIGKILL")
    }

    override fun emit(event: JSONObject) {
        diagnostic("received backend event ${event.getString("event")} process=${event.optInt("processId", 0)}")
        when (event.getString("event")) {
            "backend-error" -> failEnvironment(event.getString("environmentId"), "EIO")
            "spawn" -> onSpawn(event)
            "stdout", "stderr" -> onOutput(event)
            "ack" -> onAck(event)
            "error" -> onError(event)
            "exit", "close" -> onTerminal(event)
        }
    }

    override fun close() {
        val owned = synchronized(lifecycleLock) {
            if (!closed.compareAndSet(false, true)) return
            (processes.values + resources.values).toSet().also {
                processes.clear()
                processesByBackendId.clear()
                resources.clear()
            }
        }
        owned.forEach { state ->
            if (!state.closed) runCatching { signal(state, "SIGKILL") }
            closeState(state, "ERR_INVALID_STATE")
            state.closeChannels()
        }
        networkPreflights.clear()
        timeoutExecutor.shutdownNow()
    }

    private fun spawn(request: JSONObject, resource: JSONObject): String {
        val member = request.getString("member")
        if (member.endsWith("Sync")) return failure("provider.unavailable")
        val arguments = request.getJSONObject("arguments")
        val invocation = resource.getString("invocation")
        if (invocation != "program" && invocation != "shell") return failure("resource.invalid")
        val executableId = if (invocation == "program") {
            arguments.getString("executableId")
        } else {
            resource.getString("shellExecutableId")
        }
        val executable = executables[executableId] ?: return failure("provider.unavailable")
        if (invocation == "shell" && !executable.shell) return failure("provider.unavailable")
        if (!hasExecuteAuthority(request, executableId, invocation == "shell")) {
            return failure("capability.denied")
        }
        val limits = policy.getJSONObject("limits")
        val options = arguments.getJSONObject("options")
        val environmentScope = arguments.getString("environmentScope")
        if (
            options.has("cwd") ||
            environmentScope != resource.getString("environmentScope") ||
            environmentScope !in allowedScopes()
        ) {
            return failure("policy.denied")
        }
        val args = buildAndroidV86CommandArgs(
            invocation = invocation,
            fixedArgs = executable.fixedArgs,
            programArgs = arguments.optJSONArray("args").strings(),
            shellCommand = arguments.optString("command").takeIf(String::isNotEmpty),
        ) ?: return failure("argument.invalid")
        val executablePolicy = policy.getJSONArray("executables").objects()
            .firstOrNull { item -> item.getString("executableId") == executableId }
            ?: return failure("policy.denied")
        if (args.sumOf { value -> value.toByteArray().size } > executablePolicy.getInt("argumentBytes")) {
            return failure("policy.denied")
        }
        val environmentVariables = environment(options.optJSONObject("env")) ?: return failure("policy.denied")
        val stdio = options.optJSONArray("stdio")?.strings() ?: listOf("pipe", "pipe", "pipe")
        if (stdio.size != 3 || stdio.any { value -> value !in setOf("pipe", "ignore") }) {
            return failure("argument.invalid")
        }
        synchronized(processLimitLock) {
            if (
                processes.size >= limits.getInt("maxConcurrentProcesses") ||
                totalProcessStarts >= limits.getInt("maxTotalProcesses")
            ) {
                diagnostic(
                    "rejected spawn executable=$executableId by process limits " +
                        "concurrent=${processes.size} total=$totalProcessStarts",
                )
                return failure("resource.handle_limit")
            }
            totalProcessStarts += 1
        }
        val resourceId = "android-v86-process-${nextId.getAndIncrement()}"
        val environment = runCatching { backend.acquire(environmentScope, resourceId) }.getOrElse {
            return failure("provider.unavailable")
        }
        val state = createState(
            executableId,
            resource.getString("semanticResourceDigest"),
            environment,
            resourceId,
            stdio,
            limits,
        )
        val committed = runCatching {
            synchronized(lifecycleLock) {
                check(!closed.get()) { "Android v86 Process Provider closed during spawn" }
                processes[state.resourceId] = state
                bind(state)
                state.environment.backend.submit(
                    JSONObject()
                        .put("args", JSONArray(args))
                        .put("cwd", "/workspace")
                        .put("env", environmentVariables)
                        .put("executable", executable.path)
                        .put("executableId", executableId)
                        .put("operation", "spawn")
                        .put("resourceId", state.resourceId)
                        .put("stdio", JSONArray(stdio)),
                )
                state.timeout = timeoutExecutor.schedule(
                    { timeout(state) },
                    effectiveAndroidV86ProcessTimeoutMs(
                        options.optLong("timeoutMs").takeIf { options.has("timeoutMs") },
                        limits.getLong("maxExecutionTimeMs"),
                    ),
                    TimeUnit.MILLISECONDS,
                )
            }
            true
        }.getOrElse {
            false
        }
        if (!committed) {
            backend.invalidate(state.environment.environmentId)
            unbind(state)
            return failure("provider.unavailable")
        }
        diagnostic("accepted spawn executable=$executableId resource=${state.resourceId}")
        return success(state.facade, publications(state))
    }

    private fun invokeResource(request: JSONObject): String {
        val bindingId = request.optString("inheritedBindingId")
        val state = resources[bindingId] ?: return failure("resource.stale")
        return when (request.getString("operation")) {
            "process.signal.send" -> {
                val signal = request.optString("arguments", "SIGTERM")
                if (signal !in setOf("SIGINT", "SIGKILL", "SIGTERM") || !hasSignalAuthority(request, signal)) {
                    failure("capability.denied")
                } else {
                    signal(state, signal)
                    success(true)
                }
            }
            "process.stdin.write" -> write(request, state)
            "process.stdin.end" -> end(request, state)
            "process.stdio.pause" -> state.channel(bindingId)?.let { it.pause(); success(state.facadeFor(bindingId)) }
                ?: failure("resource.stale")
            "process.stdio.resume" -> state.channel(bindingId)?.let { it.resume(); success(state.facadeFor(bindingId)) }
                ?: failure("resource.stale")
            "process.stdio.destroy" -> {
                resources.remove(bindingId)?.channel(bindingId)?.close()
                success(state.facadeFor(bindingId))
            }
            "process.resource.close" -> {
                signal(state, "SIGKILL")
                success(JSONObject())
            }
            else -> failure("provider.unavailable")
        }
    }

    private fun write(request: JSONObject, state: AndroidV86ProcessState): String {
        val bytes = runCatching { decodeProcessInput(request.get("arguments")) }.getOrNull()
            ?: return failure("argument.invalid")
        val callbackId = callbackId(request)
        return when (
            val admission = state.stdin.write(bytes, callbackId) { processId, command ->
                submitStdin(state, processId, command)
            }
        ) {
            is AndroidV86StdinAdmission.Accepted -> success(true)
            is AndroidV86StdinAdmission.Rejected -> failure(admission.code)
        }
    }

    private fun end(request: JSONObject, state: AndroidV86ProcessState): String {
        val callbackId = callbackId(request)
        return when (
            val admission = state.stdin.end(callbackId) { processId, command ->
                submitStdin(state, processId, command)
            }
        ) {
            is AndroidV86StdinAdmission.Accepted -> {
                admission.immediateCallbackId?.let { state.stdinEvents.emit(callbackEvent(it, null)) }
                success(state.facade.getJSONObject("stdin"))
            }
            is AndroidV86StdinAdmission.Rejected -> failure(admission.code)
        }
    }

    private fun authorizeNetwork(request: JSONObject, resource: JSONObject): String {
        val accepted = request.getJSONArray("authorityBindings").objects().any { binding ->
            binding.getString("providerModule") == "host.process" &&
                binding.getString("capabilityName") == "host.process.network" &&
                binding.getJSONObject("constraints").getInt("maxSockets") > 0
        }
        if (!accepted) return failure("capability.denied")
        val binding = request.getJSONObject("invocationBinding")
        if (
            binding.getLong("generation") != generation ||
            binding.getString("semanticResourceDigest") != resource.getString("semanticResourceDigest")
        ) return failure("resource.stale")
        return when (request.optString("providerPhase").takeIf(String::isNotEmpty)) {
            "preflight" -> processNetworkPreflight(request, resource)
            "verify" -> processNetworkVerify(request, resource)
            "cancel" -> {
                networkPreflights.remove(request.getString("requestId"))
                success(JSONObject())
            }
            "execute" -> processNetworkExecute(request, resource, binding)
            else -> failure("provider.protocol_error")
        }
    }

    private fun processNetworkPreflight(request: JSONObject, resource: JSONObject): String {
        val transport = networkTransport ?: return failure("provider.unavailable")
        val brokerMonotonicMs = if (request.has("brokerMonotonicMs")) {
            (request.get("brokerMonotonicMs") as? Number)?.toDouble() ?: Double.NaN
        } else {
            Double.NaN
        }
        if (!brokerMonotonicMs.isFinite() || brokerMonotonicMs < 0.0) return failure("provider.protocol_error")
        val addresses = runCatching { transport.resolve(resource.getString("hostname")) }.getOrNull()
            ?.distinct()?.sorted()?.takeIf { values -> values.isNotEmpty() && values.size <= 64 }
            ?: return failure("provider.unavailable")
        val base = brokerMonotonicMs.toLong()
        if (base > Long.MAX_VALUE - PROCESS_NETWORK_DNS_TTL_MS) return failure("provider.protocol_error")
        val resolution = ProcessNetworkResolution(addresses, base + PROCESS_NETWORK_DNS_TTL_MS)
        if (networkPreflights.putIfAbsent(request.getString("requestId"), resolution) != null) {
            return failure("provider.protocol_error")
        }
        return success(
            JSONObject().put(
                "requests",
                JSONArray().put(
                    JSONObject()
                        .put("evidence", resolution.evidence())
                        .put("reason", "networkAddress")
                        .put("resolved", JSONObject(resource.toString()))
                        .put("sideEffectCount", 0),
                ),
            ),
        )
    }

    private fun processNetworkVerify(request: JSONObject, resource: JSONObject): String {
        val resolution = networkPreflights[request.getString("requestId")]
            ?: return failure("resource.stale")
        val current = runCatching { networkTransport?.resolve(resource.getString("hostname")) }.getOrNull()
            ?.distinct()?.sorted()
            ?: return failure("provider.unavailable")
        if (current != resolution.addresses) return failure("resource.invalid")
        return success(
            JSONObject()
                .put("evidence", resolution.evidence())
                .put("resolved", JSONObject(resource.toString())),
        )
    }

    private fun processNetworkExecute(
        request: JSONObject,
        resource: JSONObject,
        binding: JSONObject,
    ): String {
        val resolution = networkPreflights.remove(request.getString("requestId"))
            ?: return failure("resource.stale")
        val authorities = request.optJSONArray("resolutionAuthorityBindings") ?: return failure("provider.protocol_error")
        val resources = request.optJSONArray("resolutionResources") ?: return failure("provider.protocol_error")
        val tokens = request.optJSONArray("resolutionTokens") ?: return failure("provider.protocol_error")
        if (authorities.length() != 1 || resources.length() != 1 || tokens.length() != 1) {
            return failure("provider.protocol_error")
        }
        val token = tokens.getJSONObject(0)
        val digest = resource.getString("semanticResourceDigest")
        if (
            token.getLong("generation") != generation ||
            token.getString("parentRequestId") != request.getString("requestId") ||
            token.getString("requestedSemanticDigest") != digest ||
            token.getString("resolvedSemanticDigest") != digest ||
            resources.getJSONObject(0).getString("semanticResourceDigest") != digest ||
            token.getLong("expiresAtMonotonicMs") != resolution.expiresAtMonotonicMs ||
            token.getString("evidenceDigest") != resolution.evidenceDigest()
        ) return failure("resource.invalid")
        return success(
            JSONObject().put("authorized", true).put("generation", generation)
                .put("invocationBindingDigest", binding.getString("invocationBindingDigest"))
                .put("resolution", resolution.receipt())
                .put("semanticResourceDigest", digest),
        )
    }

    private fun authorizeDescendant(request: JSONObject): String {
        val resource = request.getJSONObject("resource")
        val arguments = request.getJSONObject("arguments")
        val source = request.getJSONObject("source")
        if (
            resource.getString("kind") != "processExecutable" ||
            resource.getString("invocation") != "program" ||
            source.getString("kind") != "linuxProcess"
        ) return failure("resource.invalid")
        val executableId = resource.getString("executableId")
        val executable = executables[executableId]
        val state = processes[source.getString("processResourceId")] ?: return failure("resource.stale")
        val rejectionReasons = buildList {
            if (executable == null) add("missingExecutable")
            if (executable?.shell == true) add("shellExecutable")
            if (executable?.path != arguments.getString("path")) add("pathMismatch")
            if (source.getInt("linuxPid") != arguments.getInt("linuxPid")) add("callerPidMismatch")
            if (source.getLong("processStartTimeTicks") != arguments.getLong("processStartTimeTicks")) {
                add("processIdentityMismatch")
            }
            if (source.getInt("rootLinuxPid") != state.linuxPid) add("rootPidMismatch")
            if (source.getString("environmentId") != arguments.getString("environmentId")) {
                add("environmentMismatch")
            }
            if (source.getInt("parentLinuxPid") != arguments.getInt("parentLinuxPid")) {
                add("parentPidMismatch")
            }
            if (resource.getString("environmentScope") != arguments.getString("environmentScope")) {
                add("scopeMismatch")
            }
            if (resource.getString("environmentScope") !in allowedScopes()) add("scopeDenied")
            if (!hasExecuteAuthority(request, executableId)) add("authorityMissing")
        }
        if (rejectionReasons.isNotEmpty()) {
            diagnostic("rejected descendant executable=$executableId reasons=${rejectionReasons.joinToString(",")}")
            return failure("policy.denied")
        }
        val executablePolicy = policy.getJSONArray("executables").objects()
            .firstOrNull { item -> item.getString("executableId") == executableId }
            ?: return failure("policy.denied")
        val argv = arguments.getJSONArray("argv").strings()
        val argumentBytes = argv.drop(1).sumOf { value -> value.toByteArray(Charsets.UTF_8).size }
        if (argumentBytes > executablePolicy.getInt("argumentBytes")) return failure("policy.denied")
        val binding = request.getJSONObject("invocationBinding")
        if (
            binding.getLong("generation") != generation ||
            binding.getString("semanticResourceDigest") != resource.getString("semanticResourceDigest")
        ) return failure("resource.invalid")
        val linuxPid = arguments.getInt("linuxPid")
        val parentLinuxPid = arguments.getInt("parentLinuxPid")
        val processStartTimeTicks = arguments.getLong("processStartTimeTicks")
        val limits = policy.getJSONObject("limits")
        synchronized(lifecycleLock) {
            if (closed.get() || processes[state.resourceId] !== state || state.closed) return failure("resource.stale")
            synchronized(processLimitLock) {
                var caller = state.linuxProcessesByPid[linuxPid]
                if (caller?.processStartTimeTicks != processStartTimeTicks) {
                    val rootLinuxPid = state.linuxPid ?: return failure("resource.stale")
                    if (linuxPid == rootLinuxPid && caller?.processStartTimeTicks != null) {
                        return failure("resource.stale")
                    }
                    val parent = if (linuxPid == rootLinuxPid) null else state.linuxProcessesByPid[parentLinuxPid]
                    val depth = if (linuxPid == rootLinuxPid) {
                        1
                    } else {
                        (parent?.depth ?: return failure("policy.denied")) + 1
                    }
                    if (
                        depth > limits.getInt("maxProcessTreeDepth") ||
                        linuxPid != rootLinuxPid && totalProcessStarts >= limits.getInt("maxTotalProcesses")
                    ) return failure("resource.handle_limit")
                    caller = AndroidV86LinuxProcessIdentity(
                        depth = depth,
                        executableId = if (linuxPid == rootLinuxPid) {
                            state.executableId
                        } else {
                            parent?.executableId ?: return failure("policy.denied")
                        },
                        processStartTimeTicks = processStartTimeTicks,
                    )
                    state.linuxProcessesByPid[linuxPid] = caller
                    if (linuxPid != rootLinuxPid) totalProcessStarts += 1
                }
                val admittedCaller = caller ?: return failure("resource.stale")
                val committedExecutableId = source.getString("executableId")
                if (committedExecutableId !in executables) return failure("policy.denied")
                if (admittedCaller.executableId != committedExecutableId) {
                    caller = admittedCaller.copy(executableId = committedExecutableId)
                    state.linuxProcessesByPid[linuxPid] = caller
                }
            }
        }
        return success(
            JSONObject()
                .put("authorized", true)
                .put("generation", generation)
                .put("invocationBindingDigest", binding.getString("invocationBindingDigest"))
                .put("semanticResourceDigest", resource.getString("semanticResourceDigest")),
        )
    }

    private fun signal(state: AndroidV86ProcessState, value: String) {
        val command = synchronized(state) {
            if (state.closed) return
            state.terminalSignal = strongerAndroidV86Signal(state.terminalSignal, value)
            signalCommand(state)
        }
        submitSignal(state, command)
    }

    private fun timeout(state: AndroidV86ProcessState) {
        synchronized(state) {
            if (state.closed) return
            state.childEvents.emit(processEvent("error", processError("ETIMEDOUT")))
            signal(state, "SIGKILL")
        }
    }

    private fun createState(
        executableId: String,
        executableDigest: String,
        environment: AndroidV86EnvironmentLease,
        resourceId: String,
        stdio: List<String>,
        limits: JSONObject,
    ): AndroidV86ProcessState {
        val binding = { suffix: String, type: String ->
            JSONObject()
                .put("binding", JSONObject().put("bindingId", "$resourceId-$suffix").put("generation", generation))
                .put("resourceType", type)
        }
        val facade = binding("child", "process.child")
            .put("pid", nextId.getAndIncrement())
            .put("stdin", if (stdio[0] == "pipe") binding("stdin", "process.stdin") else JSONObject.NULL)
            .put("stdout", if (stdio[1] == "pipe") binding("stdout", "process.readable") else JSONObject.NULL)
            .put("stderr", if (stdio[2] == "pipe") binding("stderr", "process.readable") else JSONObject.NULL)
        return AndroidV86ProcessState(
            executableId,
            executableDigest,
            environment,
            facade,
            resourceId,
            AndroidV86EventChannel(256 * 1024),
            AndroidV86EventChannel(64 * 1024),
            AndroidV86EventChannel(limits.getLong("maxStdoutBytes")),
            AndroidV86EventChannel(limits.getLong("maxStderrBytes")),
            AndroidV86StdinQueue(limits.getLong("maxStdinBytes")),
        )
    }

    private fun bind(state: AndroidV86ProcessState) {
        listOfNotNull(
            state.childBindingId,
            state.stdinBindingId,
            state.stdoutBindingId,
            state.stderrBindingId,
        ).forEach { bindingId ->
            check(resources.putIfAbsent(bindingId, state) == null)
        }
    }

    private fun unbind(state: AndroidV86ProcessState) {
        processes.remove(state.resourceId, state)
        listOfNotNull(
            state.childBindingId,
            state.stdinBindingId,
            state.stdoutBindingId,
            state.stderrBindingId,
        ).forEach { bindingId -> resources.remove(bindingId, state) }
        state.closeChannels()
        state.environment.close()
    }

    private fun publications(state: AndroidV86ProcessState): JSONArray {
        val processInstance = JSONObject()
            .put("executableSemanticResourceDigest", state.executableDigest)
            .put("generation", generation)
            .put("label", state.resourceId)
            .put("processResourceId", state.resourceId)
        val publication = { bindingId: String, type: String, schema: String ->
            JSONObject()
                .put("bindingId", bindingId)
                .put("eventSchemaId", schema)
                .put("processInstance", processInstance)
                .put("resourceType", type)
        }
        return JSONArray()
            .put(publication(state.childBindingId, "process.child", "ChildProcessEventV1"))
            .apply {
                state.stdinBindingId?.let {
                    put(publication(it, "process.stdin", "ChildProcessStdinEventV1"))
                }
                state.stdoutBindingId?.let {
                    put(publication(it, "process.readable", "ChildProcessReadableEventV1"))
                }
                state.stderrBindingId?.let {
                    put(publication(it, "process.readable", "ChildProcessReadableEventV1"))
                }
            }
    }

    private fun onSpawn(event: JSONObject) {
        synchronized(lifecycleLock) {
            if (closed.get()) return
            val state = processes[event.getString("resourceId")] ?: return
            if (event.getString("environmentId") != state.environment.environmentId) return
            val backendProcessId = event.getInt("processId")
            val linuxPid = event.getInt("linuxPid")
            val signalCommand = synchronized(state) {
                if (state.closed || processes[state.resourceId] !== state) return
                state.backendProcessId = backendProcessId
                state.linuxPid = linuxPid
                state.linuxProcessesByPid[linuxPid] = AndroidV86LinuxProcessIdentity(
                    depth = 1,
                    executableId = state.executableId,
                    processStartTimeTicks = null,
                )
                processesByBackendId[backendProcessKey(state.environment.environmentId, backendProcessId)] = state
                signalCommand(state)
            }
            state.childEvents.emit(processEvent("spawn"))
            if (signalCommand != null) submitSignal(state, signalCommand)
            state.stdin.attachProcess(backendProcessId) { processId, command -> submitStdin(state, processId, command) }
                ?.let {
                    state.childEvents.emit(processEvent("error", processError("ERR_OPERATION_FAILED")))
                    if (closeState(state, "ERR_INVALID_STATE")) {
                        state.childEvents.emit(processEvent("close", null, null))
                    }
                }
        }
    }

    private fun signalCommand(state: AndroidV86ProcessState): AndroidV86SignalCommand? {
        val processId = state.backendProcessId ?: return null
        val signal = state.terminalSignal ?: return null
        if (state.submittedSignal == signal) return null
        state.submittedSignal = signal
        return AndroidV86SignalCommand(processId, signal)
    }

    private fun submitSignal(state: AndroidV86ProcessState, command: AndroidV86SignalCommand?) {
        if (command == null) return
        runCatching {
            state.environment.backend.submit(
                JSONObject()
                    .put("operation", "signal")
                    .put("processId", command.processId)
                    .put("signal", command.signal),
            )
        }.onFailure {
            failEnvironment(state.environment.environmentId, "EIO")
        }
    }

    private fun closeState(state: AndroidV86ProcessState, stdinCode: String): Boolean = synchronized(state) {
        if (state.closed) return false
        state.closed = true
        state.timeout?.cancel(false)
        state.timeout = null
        state.terminalSignal = null
        state.submittedSignal = null
        state.backendProcessId?.let { processId ->
            processesByBackendId.remove(backendProcessKey(state.environment.environmentId, processId), state)
        }
        processes.remove(state.resourceId)
        diagnostic("closed process executable=${state.executableId} active=${processes.size}")
        state.stdin.close().forEach { callbackId ->
            state.stdinEvents.emit(callbackEvent(callbackId, processError(stdinCode)))
        }
        state.stdinEvents.emit(JSONObject().put("event", "close").toString())
        state.stdoutEvents.emit(processEvent("end"))
        state.stdoutEvents.emit(processEvent("close"))
        state.stderrEvents.emit(processEvent("end"))
        state.stderrEvents.emit(processEvent("close"))
        state.environment.close()
        return true
    }

    private fun onOutput(event: JSONObject) {
        val state = processFor(event) ?: return
        val bytes = ByteArray(event.getJSONArray("bytes").length()) { index ->
            event.getJSONArray("bytes").getInt(index).toByte()
        }
        val channel = if (event.getString("event") == "stdout") state.stdoutEvents else state.stderrEvents
        if (
            !channel.emit(processEvent("data", binarySnapshot(bytes)), bytes.size) &&
            state.outputLimitExceeded.compareAndSet(false, true)
        ) {
            state.childEvents.emit(processEvent("error", processError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")))
            signal(state, "SIGKILL")
        }
    }

    private fun onAck(event: JSONObject) {
        val state = processFor(event) ?: return
        val callbackId = event.optLong("callbackId", -1)
        if (callbackId > 0 && state.stdin.acknowledge(callbackId)) {
            state.stdinEvents.emit(callbackEvent(callbackId, null))
        }
    }

    private fun onError(event: JSONObject) {
        if (event.optString("operation") == "filesystem") return
        val state = event.optString("resourceId").takeIf(String::isNotEmpty)?.let(processes::get)
            ?: event.optInt("processId", -1).takeIf { it >= 0 }?.let { processFor(event) }
            ?: return
        val callbackId = event.optLong("callbackId", -1)
        if (callbackId > 0 && state.stdin.acknowledge(callbackId)) {
            state.stdinEvents.emit(callbackEvent(callbackId, processError("EIO")))
        } else {
            state.childEvents.emit(processEvent("error", processError("ERR_OPERATION_FAILED")))
            if (state.linuxPid == null) {
                if (closeState(state, "ERR_INVALID_STATE")) {
                    state.childEvents.emit(processEvent("close", null, null))
                }
            }
        }
    }

    private fun onTerminal(event: JSONObject) {
        val state = processFor(event) ?: return
        val code = event.opt("code").takeUnless { it == JSONObject.NULL }
        val signal = event.opt("signal").takeUnless { it == JSONObject.NULL }
        if (event.getString("event") == "close") {
            if (closeState(state, "ERR_INVALID_STATE")) {
                state.childEvents.emit(processEvent("close", code, signal))
            }
        } else {
            state.childEvents.emit(processEvent(event.getString("event"), code, signal))
        }
    }


    private fun failEnvironment(environmentId: String, code: String) {
        backend.invalidate(environmentId)
        processes.values.toSet().filter { state -> state.environment.environmentId == environmentId }.forEach { state ->
            state.childEvents.emit(processEvent("error", processError(code)))
            if (closeState(state, "ERR_INVALID_STATE")) {
                state.childEvents.emit(processEvent("close", null, null))
            }
        }
    }

    private fun callbackId(request: JSONObject): Long? = request.optJSONObject("providerData")
        ?.optLong("callbackId", -1)
        ?.takeIf { it > 0 }

    private fun hasExecuteAuthority(
        request: JSONObject,
        executableId: String,
        requireShell: Boolean = false,
    ): Boolean {
        val bindings = request.getJSONArray("authorityBindings").objects()
            .filter { binding -> binding.getString("providerModule") == "host.process" }
        val execute = bindings.any { binding ->
            binding.getString("capabilityName") == "host.process.execute" &&
                binding.getJSONObject("constraints").getJSONArray("executableIds").strings().contains(executableId) &&
                binding.getJSONObject("constraints").getJSONObject("limits").getInt("maxConcurrentProcesses") > 0
        }
        val shell = !requireShell || bindings.any { binding ->
            binding.getString("capabilityName") == "host.process.shell" &&
                binding.getJSONObject("constraints").getJSONArray("executableIds").strings().contains(executableId)
        }
        return execute && shell
    }

    private fun hasSignalAuthority(request: JSONObject, signal: String): Boolean =
        request.getJSONArray("authorityBindings").objects().any { binding ->
            binding.getString("providerModule") == "host.process" &&
                binding.getString("capabilityName") == "host.process.signal" &&
                binding.getJSONObject("constraints").getJSONArray("signals").strings().contains(signal)
        }

    private fun allowedScopes(): List<String> = profileEnvironment.getJSONArray("allowedScopes").strings()

    private fun environment(source: JSONObject?): JSONObject? {
        if (source == null) return JSONObject()
        val policyEnvironment = policy.getJSONObject("environment")
        val allowed = policyEnvironment.getJSONArray("allowedNames").strings().toSet()
        val maximum = policyEnvironment.getInt("maxValueBytes")
        if (source.keys().asSequence().any { name ->
                name !in allowed || source.optString(name).toByteArray().size > maximum
            }
        ) return null
        return JSONObject(source.toString())
    }

    private val profileEnvironment = profile.getJSONObject("environment")

    private fun diagnostic(message: String) {
        if (diagnostics) Log.d(TAG, message)
    }

    private fun submitStdin(state: AndroidV86ProcessState, processId: Int, command: AndroidV86StdinCommand) {
        state.environment.backend.submit(
            JSONObject()
                .put("operation", command.operation)
                .put("processId", processId)
                .apply {
                    command.bytes?.let { bytes -> put("bytes", JSONArray(bytes.map(Byte::toInt))) }
                    command.callbackId?.let { callbackId -> put("callbackId", callbackId) }
                },
        )
    }

    private fun processFor(event: JSONObject): AndroidV86ProcessState? = processesByBackendId[
        backendProcessKey(event.getString("environmentId"), event.getInt("processId")),
    ]

    private fun backendProcessKey(environmentId: String, processId: Int) = "$environmentId:$processId"

    private inner class ProcessNetworkResolution(
        val addresses: List<String>,
        val expiresAtMonotonicMs: Long,
    ) {
        fun evidence() = JSONObject()
            .put("addresses", JSONArray(addresses))
            .put("expiresAtMonotonicMs", expiresAtMonotonicMs)
            .put("kind", "networkAddress")
            .put("resolverGeneration", generation)

        fun evidenceDigest(): String {
            val canonical = JSONArray().put("resolutionEvidence").put(evidence()).toString()
            return MessageDigest.getInstance("SHA-256")
                .digest(canonical.toByteArray(Charsets.UTF_8))
                .joinToString("") { byte -> "%02x".format(byte) }
        }

        fun receipt() = JSONObject()
            .put("addresses", JSONArray(addresses))
            .put("evidenceDigest", evidenceDigest())
            .put("expiresAtMonotonicMs", expiresAtMonotonicMs)
            .put("resolverGeneration", generation)
    }

    private companion object {
        private const val PROCESS_NETWORK_DNS_TTL_MS = 30_000L
        private const val TAG = "HolonomyV86Provider"
        private fun parseExecutables(profile: JSONObject): Map<String, AndroidV86Executable> =
            profile.getJSONArray("executables").objects().associate { item ->
                val id = item.getString("executableId")
                val executable = item.getJSONObject("executable")
                require(executable.getString("kind") == "guestPath")
                id to AndroidV86Executable(
                    id,
                    executable.getString("path"),
                    item.getJSONArray("fixedArgs").strings(),
                    item.getBoolean("shell"),
                )
            }
        private fun callbackEvent(callbackId: Long, error: JSONObject?) = JSONObject()
            .put("callbackId", callbackId).put("error", error ?: JSONObject.NULL).put("event", "callback").toString()
        private fun success(value: Any, resources: JSONArray? = null) = JSONObject()
            .put("ok", true).put("value", value).apply { if (resources != null) put("resources", resources) }.toString()
        private fun failure(code: String) = JSONObject().put("ok", false)
            .put("error", JSONObject().put("code", code)).toString()
        private fun JSONArray.objects() = List(length(), ::getJSONObject)
        private fun JSONArray?.strings() = if (this == null) emptyList() else List(length(), ::getString)
        private fun AndroidV86ProcessState.facadeFor(bindingId: String): JSONObject = when (bindingId) {
            childBindingId -> facade
            stdinBindingId -> facade.getJSONObject("stdin")
            stdoutBindingId -> facade.getJSONObject("stdout")
            stderrBindingId -> facade.getJSONObject("stderr")
            else -> throw IllegalArgumentException("Unknown process binding")
        }
    }
}

internal fun buildAndroidV86CommandArgs(
    invocation: String,
    fixedArgs: List<String>,
    programArgs: List<String>,
    shellCommand: String?,
): List<String>? = when (invocation) {
    "program" -> fixedArgs + programArgs
    "shell" -> shellCommand?.let { command -> fixedArgs + listOf("-c", command) }
    else -> null
}

internal fun effectiveAndroidV86ProcessTimeoutMs(requested: Long?, maximum: Long): Long {
    require((requested ?: maximum) > 0 && maximum > 0)
    return minOf(requested ?: maximum, maximum)
}

internal data class AndroidV86SignalCommand(val processId: Int, val signal: String)

internal fun strongerAndroidV86Signal(current: String?, requested: String): String {
    val priority = mapOf("SIGINT" to 1, "SIGTERM" to 2, "SIGKILL" to 3)
    require(requested in priority)
    if (current == null) return requested
    require(current in priority)
    return if (priority.getValue(requested) > priority.getValue(current)) requested else current
}
