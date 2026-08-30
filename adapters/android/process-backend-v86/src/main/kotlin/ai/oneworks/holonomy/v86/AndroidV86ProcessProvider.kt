package ai.oneworks.holonomy.v86

import android.util.Log
import ai.oneworks.holonomy.capability.AndroidProcessCapabilityProvider
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject

/** Android Provider for the asynchronous Node child_process facade backed by v86/Linux. */
class AndroidV86ProcessProvider(
    private val generation: Long,
    private val policy: JSONObject,
    profile: JSONObject,
    private val backend: AndroidV86ProcessBackend,
    private val diagnostics: Boolean = false,
) : AndroidProcessCapabilityProvider, AndroidV86ProcessEventSink {
    private val closed = AtomicBoolean(false)
    private val executables = parseExecutables(profile)
    private val nextId = AtomicInteger(1)
    private val processLimitLock = Any()
    private val resources = ConcurrentHashMap<String, AndroidV86ProcessState>()
    private val processes = ConcurrentHashMap<String, AndroidV86ProcessState>()
    private val processesByBackendId = ConcurrentHashMap<Int, AndroidV86ProcessState>()
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
        if (bindingId == state.childBindingId && !state.closed) signal(state, "SIGKILL")
    }

    override fun emit(event: JSONObject) {
        diagnostic("received backend event ${event.getString("event")} process=${event.optInt("processId", 0)}")
        when (event.getString("event")) {
            "backend-error" -> failAll("EIO")
            "spawn" -> onSpawn(event)
            "stdout", "stderr" -> onOutput(event)
            "ack" -> onAck(event)
            "error" -> onError(event)
            "exit", "close" -> onTerminal(event)
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        processes.values.toSet().forEach { state ->
            if (!state.closed) runCatching { signal(state, "SIGKILL") }
            closeState(state, "ERR_INVALID_STATE")
        }
        processes.clear()
        processesByBackendId.clear()
        resources.clear()
    }

    private fun spawn(request: JSONObject, resource: JSONObject): String {
        val member = request.getString("member")
        if (member.endsWith("Sync") || resource.getString("invocation") != "program") {
            return failure("provider.unavailable")
        }
        val arguments = request.getJSONObject("arguments")
        val executableId = arguments.getString("executableId")
        val executable = executables[executableId] ?: return failure("provider.unavailable")
        if (!hasExecuteAuthority(request, executableId)) return failure("capability.denied")
        val limits = policy.getJSONObject("limits")
        val options = arguments.getJSONObject("options")
        if (options.has("cwd") || arguments.getString("environmentScope") !in allowedScopes()) {
            return failure("policy.denied")
        }
        val args = executable.fixedArgs + arguments.optJSONArray("args").strings()
        val executablePolicy = policy.getJSONArray("executables").objects()
            .firstOrNull { item -> item.getString("executableId") == executableId }
            ?: return failure("policy.denied")
        if (args.sumOf { value -> value.toByteArray().size } > executablePolicy.getInt("argumentBytes")) {
            return failure("policy.denied")
        }
        val environment = environment(options.optJSONObject("env")) ?: return failure("policy.denied")
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
        val state = createState(executableId, resource.getString("semanticResourceDigest"), stdio, limits)
        processes[state.resourceId] = state
        bind(state)
        runCatching {
            backend.submit(
                JSONObject()
                    .put("args", JSONArray(args))
                    .put("cwd", "/workspace")
                    .put("env", environment)
                    .put("executable", executable.path)
                    .put("executableId", executableId)
                    .put("operation", "spawn")
                    .put("resourceId", state.resourceId)
                    .put("stdio", JSONArray(stdio)),
            )
        }.getOrElse {
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
        return when (val admission = state.stdin.write(bytes, callbackId, ::submitStdin)) {
            is AndroidV86StdinAdmission.Accepted -> success(true)
            is AndroidV86StdinAdmission.Rejected -> failure(admission.code)
        }
    }

    private fun end(request: JSONObject, state: AndroidV86ProcessState): String {
        val callbackId = callbackId(request)
        return when (val admission = state.stdin.end(callbackId, ::submitStdin)) {
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
        return success(
            JSONObject().put("authorized", true).put("generation", generation)
                .put("invocationBindingDigest", binding.getString("invocationBindingDigest"))
                .put("semanticResourceDigest", resource.getString("semanticResourceDigest")),
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
            if (source.getString("executableId") != executableId) add("sourceExecutableMismatch")
            if (source.getInt("linuxPid") != state.linuxPid) add("rootPidMismatch")
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
        val limits = policy.getJSONObject("limits")
        synchronized(processLimitLock) {
            if (!state.linuxDepthByPid.containsKey(linuxPid)) {
                val parentDepth = state.linuxDepthByPid[parentLinuxPid] ?: return failure("policy.denied")
                if (
                    parentDepth + 1 > limits.getInt("maxProcessTreeDepth") ||
                    totalProcessStarts >= limits.getInt("maxTotalProcesses")
                ) return failure("resource.handle_limit")
                state.linuxDepthByPid[linuxPid] = parentDepth + 1
                totalProcessStarts += 1
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
        state.backendProcessId?.let { processId ->
            backend.submit(JSONObject().put("operation", "signal").put("processId", processId).put("signal", value))
        }
    }

    private fun createState(
        executableId: String,
        executableDigest: String,
        stdio: List<String>,
        limits: JSONObject,
    ): AndroidV86ProcessState {
        val resourceId = "android-v86-process-${nextId.getAndIncrement()}"
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
        val state = processes[event.getString("resourceId")] ?: return
        val backendProcessId = event.getInt("processId")
        val linuxPid = event.getInt("linuxPid")
        state.backendProcessId = backendProcessId
        state.linuxPid = linuxPid
        state.linuxDepthByPid[linuxPid] = 1
        processesByBackendId[backendProcessId] = state
        state.childEvents.emit(processEvent("spawn"))
        state.stdin.attachProcess(backendProcessId, ::submitStdin)?.let {
            state.childEvents.emit(processEvent("error", processError("ERR_OPERATION_FAILED")))
            if (closeState(state, "ERR_INVALID_STATE")) {
                state.childEvents.emit(processEvent("close", null, null))
            }
        }
    }

    private fun onOutput(event: JSONObject) {
        val state = processesByBackendId[event.getInt("processId")] ?: return
        val bytes = ByteArray(event.getJSONArray("bytes").length()) { index ->
            event.getJSONArray("bytes").getInt(index).toByte()
        }
        val channel = if (event.getString("event") == "stdout") state.stdoutEvents else state.stderrEvents
        if (!channel.emit(processEvent("data", binarySnapshot(bytes)), bytes.size)) {
            state.childEvents.emit(processEvent("error", processError("ERR_CHILD_PROCESS_STDIO_MAXBUFFER")))
            signal(state, "SIGKILL")
        }
    }

    private fun onAck(event: JSONObject) {
        val state = processesByBackendId[event.getInt("processId")] ?: return
        val callbackId = event.optLong("callbackId", -1)
        if (callbackId > 0 && state.stdin.acknowledge(callbackId)) {
            state.stdinEvents.emit(callbackEvent(callbackId, null))
        }
    }

    private fun onError(event: JSONObject) {
        if (event.optString("operation") == "filesystem") return
        val state = event.optString("resourceId").takeIf(String::isNotEmpty)?.let(processes::get)
            ?: event.optInt("processId", -1).takeIf { it >= 0 }?.let(processesByBackendId::get)
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
        val state = processesByBackendId[event.getInt("processId")] ?: return
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

    private fun closeState(state: AndroidV86ProcessState, stdinCode: String): Boolean {
        if (state.closed) return false
        state.closed = true
        state.backendProcessId?.let(processesByBackendId::remove)
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
        return true
    }

    private fun failAll(code: String) {
        processes.values.toSet().forEach { state ->
            state.childEvents.emit(processEvent("error", processError(code)))
            if (closeState(state, "ERR_INVALID_STATE")) {
                state.childEvents.emit(processEvent("close", null, null))
            }
        }
    }

    private fun callbackId(request: JSONObject): Long? = request.optJSONObject("providerData")
        ?.optLong("callbackId", -1)
        ?.takeIf { it > 0 }

    private fun hasExecuteAuthority(request: JSONObject, executableId: String): Boolean =
        request.getJSONArray("authorityBindings").objects().any { binding ->
            binding.getString("providerModule") == "host.process" &&
                binding.getString("capabilityName") == "host.process.execute" &&
                binding.getJSONObject("constraints").getJSONArray("executableIds").strings().contains(executableId) &&
                binding.getJSONObject("constraints").getJSONObject("limits").getInt("maxConcurrentProcesses") > 0
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

    private fun submitStdin(processId: Int, command: AndroidV86StdinCommand) {
        backend.submit(
            JSONObject()
                .put("operation", command.operation)
                .put("processId", processId)
                .apply {
                    command.bytes?.let { bytes -> put("bytes", JSONArray(bytes.map(Byte::toInt))) }
                    command.callbackId?.let { callbackId -> put("callbackId", callbackId) }
                },
        )
    }

    private companion object {
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
