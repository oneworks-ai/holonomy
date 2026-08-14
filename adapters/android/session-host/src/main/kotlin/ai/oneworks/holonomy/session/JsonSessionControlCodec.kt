package ai.oneworks.holonomy.session

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

class JsonSessionControlCodec : SessionControlCodec {
    override fun encodeCommand(command: SessionCommandV2): ByteArray = commandObject(command).toBytes()

    override fun decodeCommand(bytes: ByteArray): SessionCommandV2 = decode("command", bytes) { json ->
        requireProtocol(json)
        val runtimeId = RuntimeId(json.requiredString("runtimeId"))
        val commandId = CommandId(json.requiredString("commandId"))
        val expectedGeneration = json.optionalLong("expectedGeneration")
        val kind = enumByWireName<SessionCommandKind>(json.requiredString("command"))
        json.requireOnlyKeys(
            *(
                COMMAND_KEYS + when (kind) {
                    SessionCommandKind.CREATE -> setOf("spec")
                    SessionCommandKind.STATUS -> setOf("expectedGeneration", "afterOutputSequence")
                    SessionCommandKind.CANCEL,
                    SessionCommandKind.STOP,
                    -> setOf("expectedGeneration", "reason")
                    SessionCommandKind.CONTROL -> setOf("expectedGeneration", "operation", "value")
                    SessionCommandKind.START,
                    SessionCommandKind.RESTART,
                    SessionCommandKind.DISPOSE,
                    -> setOf("expectedGeneration")
                }
            ).toTypedArray(),
        )
        when (kind) {
            SessionCommandKind.CREATE -> CreateRuntimeCommand(
                runtimeId = runtimeId,
                commandId = commandId,
                spec = decodeRuntimeSpec(json.requiredObject("spec")),
            )
            SessionCommandKind.START -> StartRuntimeCommand(runtimeId, commandId, expectedGeneration)
            SessionCommandKind.STATUS -> StatusRuntimeCommand(
                runtimeId,
                commandId,
                expectedGeneration,
                json.optionalLong("afterOutputSequence") ?: 0,
            )
            SessionCommandKind.CANCEL -> CancelRuntimeCommand(
                runtimeId,
                commandId,
                expectedGeneration,
                json.optionalString("reason"),
            )
            SessionCommandKind.STOP -> StopRuntimeCommand(
                runtimeId,
                commandId,
                expectedGeneration,
                json.optionalString("reason"),
            )
            SessionCommandKind.RESTART -> RestartRuntimeCommand(runtimeId, commandId, expectedGeneration)
            SessionCommandKind.CONTROL -> ControlRuntimeCommand(
                runtimeId = runtimeId,
                commandId = commandId,
                expectedGeneration = requireNotNull(expectedGeneration) {
                    "Control command requires expectedGeneration"
                },
                control = SessionControlOperation(
                    operation = json.requiredString("operation"),
                    valueJson = json.getRequired("value").toString(),
                ),
            )
            SessionCommandKind.DISPOSE -> DisposeRuntimeCommand(runtimeId, commandId, expectedGeneration)
        }
    }

    override fun encodeReply(reply: SessionCommandReply): ByteArray = JsonObject().apply {
        add("ack", encodeAck(reply.ack))
        reply.state?.let { add("state", encodeStateObject(it)) }
        reply.result?.let { add("result", encodeResultObject(it)) }
        reply.output?.let { add("output", encodeOutputObject(it)) }
    }.toBytes()

    override fun decodeReply(bytes: ByteArray): SessionCommandReply = decode("reply", bytes) { json ->
        SessionCommandReply(
            ack = decodeAck(json.requiredObject("ack")),
            state = json.optionalObject("state")?.let(::decodeStateObject),
            result = json.optionalObject("result")?.let(::decodeResultObject),
            output = json.optionalObject("output")?.let(::decodeOutputObject),
        )
    }

    override fun encodeState(state: SessionRuntimeSnapshot): ByteArray = encodeStateObject(state).toBytes()

    override fun decodeState(bytes: ByteArray): SessionRuntimeSnapshot =
        decode("state", bytes, ::decodeStateObject)

    override fun encodeResult(result: SessionExecutionResult): ByteArray = encodeResultObject(result).toBytes()

    override fun decodeResult(bytes: ByteArray): SessionExecutionResult =
        decode("result", bytes, ::decodeResultObject)

    override fun encodeOutput(output: SessionOutputSnapshot): ByteArray = encodeOutputObject(output).toBytes()

    override fun decodeOutput(bytes: ByteArray): SessionOutputSnapshot =
        decode("output", bytes, ::decodeOutputObject)

    private fun commandObject(command: SessionCommandV2) = JsonObject().apply {
        addProperty("protocolVersion", command.protocolVersion)
        addProperty("runtimeId", command.runtimeId.value)
        addProperty("commandId", command.commandId.value)
        addProperty("command", command.kind.wireName)
        command.expectedGeneration?.let { addProperty("expectedGeneration", it) }
        when (command) {
            is CreateRuntimeCommand -> add("spec", encodeRuntimeSpec(command.spec))
            is StatusRuntimeCommand -> addProperty("afterOutputSequence", command.afterOutputSequence)
            is CancelRuntimeCommand -> command.reason?.let { addProperty("reason", it) }
            is StopRuntimeCommand -> command.reason?.let { addProperty("reason", it) }
            is ControlRuntimeCommand -> {
                addProperty("operation", command.control.operation)
                add("value", JsonParser.parseString(command.control.valueJson))
            }
            is StartRuntimeCommand,
            is RestartRuntimeCommand,
            is DisposeRuntimeCommand,
            -> Unit
        }
    }

    private fun encodeRuntimeSpec(spec: SessionRuntimeSpec) = JsonObject().apply {
        addProperty("entryUrl", spec.entryUrl)
        add("modules", JsonArray().apply {
            spec.modules.forEach { module ->
                add(JsonObject().apply {
                    addProperty("url", module.url)
                    addProperty("source", module.source)
                })
            }
        })
        add("argv", JsonArray().apply { spec.argv.forEach(::add) })
        add("env", JsonObject().apply { spec.env.forEach(::addProperty) })
        spec.inspector?.let { inspector ->
            add("inspector", JsonObject().apply {
                addProperty("socketName", inspector.socketName)
                addProperty("breakBeforeEntry", inspector.breakBeforeEntry)
            })
        }
        addProperty("isolation", spec.isolation.wireName)
        add("initialControls", JsonArray().apply {
            spec.initialControls.forEach { control ->
                add(JsonObject().apply {
                    addProperty("operation", control.operation)
                    add("value", JsonParser.parseString(control.valueJson))
                })
            }
        })
        add("sandboxPolicy", encodeSandboxPolicy(spec.sandboxPolicy))
        spec.capabilityRuntimeJson?.let { value -> add("capabilityRuntime", JsonParser.parseString(value)) }
        if (spec.runtimePlugins.isNotEmpty()) add("runtimePlugins", encodeRuntimePluginBundles(spec.runtimePlugins))
    }

    private fun decodeRuntimeSpec(json: JsonObject): SessionRuntimeSpec {
        json.requireOnlyKeys(
            "entryUrl",
            "modules",
            "argv",
            "env",
            "inspector",
            "isolation",
            "initialControls",
            "sandboxPolicy",
            "capabilityRuntime",
            "runtimePlugins",
        )
        return SessionRuntimeSpec(
            entryUrl = json.requiredString("entryUrl"),
            modules = json.requiredArray("modules").map { element ->
                val module = element.asJsonObject.apply { requireOnlyKeys("url", "source") }
                SessionModuleSpec(module.requiredString("url"), module.requiredString("source"))
            },
            argv = json.optionalArray("argv")?.map { element -> element.asString }.orEmpty(),
            env = json.optionalObject("env")?.entrySet()?.associate { (key, value) -> key to value.asString }.orEmpty(),
            inspector = json.optionalObject("inspector")?.let { inspector ->
                inspector.requireOnlyKeys("socketName", "breakBeforeEntry")
                SessionInspectorSpec(
                    socketName = inspector.requiredString("socketName"),
                    breakBeforeEntry = inspector.optionalBoolean("breakBeforeEntry") ?: false,
                )
            },
            isolation = json.optionalString("isolation")
                ?.let { value -> enumByWireName<SessionIsolation>(value) }
                ?: SessionIsolation.LOGICAL_RUNTIME,
            initialControls = json.optionalArray("initialControls")?.map { element ->
                val control = element.asJsonObject.apply { requireOnlyKeys("operation", "value") }
                SessionControlOperation(
                    operation = control.requiredString("operation"),
                    valueJson = control.getRequired("value").toString(),
                )
            }.orEmpty(),
            sandboxPolicy = json.optionalObject("sandboxPolicy")?.let(::decodeSandboxPolicy)
                ?: SessionSandboxPolicy(),
            capabilityRuntimeJson = json.optionalObject("capabilityRuntime")?.toString(),
            runtimePlugins = decodeRuntimePluginBundles(json.optionalArray("runtimePlugins")),
        )
    }

    private fun encodeSandboxPolicy(policy: SessionSandboxPolicy) = JsonObject().apply {
        addProperty("schemaVersion", policy.schemaVersion)
        add("network", JsonObject().apply {
            addProperty("access", policy.network.access.wireName)
            if (policy.network.access != SessionSandboxNetworkAccess.NONE) {
                add("allowedOrigins", JsonArray().apply { policy.network.allowedOrigins.forEach(::add) })
                add("allowedSchemes", JsonArray().apply { policy.network.allowedSchemes.forEach(::add) })
                addProperty("allowPrivateNetwork", policy.network.allowPrivateNetwork)
                add("limits", encodeSandboxNetworkLimits(policy.network.limits))
            }
        })
        add("filesystem", JsonObject().apply {
            addProperty("access", policy.filesystem.access.wireName)
        })
    }

    private fun encodeSandboxNetworkLimits(limits: SessionSandboxNetworkLimits) = JsonObject().apply {
        addProperty("maxChunkBytes", limits.maxChunkBytes)
        addProperty("maxConcurrentConnections", limits.maxConcurrentConnections)
        addProperty("maxHeaderBytes", limits.maxHeaderBytes)
        addProperty("maxHeaders", limits.maxHeaders)
        addProperty("maxRequestBodyBytes", limits.maxRequestBodyBytes)
        addProperty("maxResponseBodyBytes", limits.maxResponseBodyBytes)
        addProperty("maxUrlBytes", limits.maxUrlBytes)
        addProperty("socketTimeoutMs", limits.socketTimeoutMs)
    }

    private fun decodeSandboxPolicy(json: JsonObject): SessionSandboxPolicy {
        json.requireOnlyKeys("schemaVersion", "network", "filesystem")
        return SessionSandboxPolicy(
            schemaVersion = json.requiredInt("schemaVersion"),
            network = decodeSandboxNetworkPolicy(json.requiredObject("network")),
            filesystem = decodeSandboxFilesystemPolicy(json.requiredObject("filesystem")),
        )
    }

    private fun decodeSandboxNetworkPolicy(json: JsonObject): SessionSandboxNetworkPolicy {
        val access = SessionSandboxNetworkAccess.entries.singleOrNull {
            it.wireName == json.requiredString("access")
        } ?: throw IllegalArgumentException("Unknown sandbox network access")
        if (access == SessionSandboxNetworkAccess.NONE) {
            json.requireOnlyKeys("access")
            return SessionSandboxNetworkPolicy()
        }
        json.requireOnlyKeys("access", "allowedOrigins", "allowedSchemes", "allowPrivateNetwork", "limits")
        val origins = json.requiredArray("allowedOrigins").map { it.asString }
        val schemes = json.requiredArray("allowedSchemes").map { it.asString }
        require(origins.size == origins.toSet().size) { "Duplicate sandbox network origin" }
        require(schemes.size == schemes.toSet().size) { "Duplicate sandbox network scheme" }
        return SessionSandboxNetworkPolicy(
            access = access,
            allowedOrigins = origins.toSet(),
            allowedSchemes = schemes.toSet(),
            allowPrivateNetwork = json.requiredBoolean("allowPrivateNetwork"),
            limits = decodeSandboxNetworkLimits(json.requiredObject("limits")),
        )
    }

    private fun decodeSandboxNetworkLimits(json: JsonObject): SessionSandboxNetworkLimits {
        json.requireOnlyKeys(
            "maxChunkBytes",
            "maxConcurrentConnections",
            "maxHeaderBytes",
            "maxHeaders",
            "maxRequestBodyBytes",
            "maxResponseBodyBytes",
            "maxUrlBytes",
            "socketTimeoutMs",
        )
        return SessionSandboxNetworkLimits(
            maxChunkBytes = json.requiredInt("maxChunkBytes"),
            maxConcurrentConnections = json.requiredInt("maxConcurrentConnections"),
            maxHeaderBytes = json.requiredInt("maxHeaderBytes"),
            maxHeaders = json.requiredInt("maxHeaders"),
            maxRequestBodyBytes = json.requiredInt("maxRequestBodyBytes"),
            maxResponseBodyBytes = json.requiredInt("maxResponseBodyBytes"),
            maxUrlBytes = json.requiredInt("maxUrlBytes"),
            socketTimeoutMs = json.requiredInt("socketTimeoutMs"),
        )
    }

    private fun decodeSandboxFilesystemPolicy(json: JsonObject): SessionSandboxFilesystemPolicy {
        json.requireOnlyKeys("access")
        val access = SessionSandboxFilesystemAccess.entries.singleOrNull {
            it.wireName == json.requiredString("access")
        } ?: throw IllegalArgumentException("Unknown sandbox filesystem access")
        return SessionSandboxFilesystemPolicy(access)
    }

    private fun encodeAck(ack: SessionCommandAck) = JsonObject().apply {
        addProperty("protocolVersion", ack.protocolVersion)
        addProperty("runtimeId", ack.runtimeId.value)
        addProperty("commandId", ack.commandId.value)
        addProperty("command", ack.command.wireName)
        addProperty("generation", ack.generation)
        addProperty("accepted", ack.accepted)
        ack.errorCode?.let { addProperty("errorCode", it.stableCode) }
    }

    private fun decodeAck(json: JsonObject): SessionCommandAck {
        requireProtocol(json)
        return SessionCommandAck(
            runtimeId = RuntimeId(json.requiredString("runtimeId")),
            commandId = CommandId(json.requiredString("commandId")),
            command = enumByWireName(json.requiredString("command")),
            generation = json.requiredLong("generation"),
            accepted = json.requiredBoolean("accepted"),
            errorCode = json.optionalString("errorCode")?.let(::errorByStableCode),
        )
    }

    private fun encodeStateObject(state: SessionRuntimeSnapshot) = JsonObject().apply {
        addProperty("runtimeId", state.runtimeId.value)
        addProperty("generation", state.generation)
        addProperty("phase", state.phase.wireName)
        addProperty("isolation", state.isolation.wireName)
        addProperty("firstAvailableOutputSequence", state.firstAvailableOutputSequence)
        addProperty("nextOutputSequence", state.nextOutputSequence)
    }

    private fun decodeStateObject(json: JsonObject) = SessionRuntimeSnapshot(
        runtimeId = RuntimeId(json.requiredString("runtimeId")),
        generation = json.requiredLong("generation"),
        phase = enumByWireName(json.requiredString("phase")),
        isolation = enumByWireName(json.requiredString("isolation")),
        firstAvailableOutputSequence = json.requiredLong("firstAvailableOutputSequence"),
        nextOutputSequence = json.requiredLong("nextOutputSequence"),
    )

    private fun encodeResultObject(result: SessionExecutionResult) = JsonObject().apply {
        addProperty("runtimeId", result.runtimeId.value)
        addProperty("generation", result.generation)
        addProperty("exitCode", result.exitCode)
        result.reason?.let { addProperty("reason", it) }
    }

    private fun decodeResultObject(json: JsonObject) = SessionExecutionResult(
        runtimeId = RuntimeId(json.requiredString("runtimeId")),
        generation = json.requiredLong("generation"),
        exitCode = json.requiredInt("exitCode"),
        reason = json.optionalString("reason"),
    )

    private fun encodeOutputObject(output: SessionOutputSnapshot) = JsonObject().apply {
        addProperty("firstAvailableSequence", output.firstAvailableSequence)
        addProperty("nextSequence", output.nextSequence)
        add("events", JsonArray().apply {
            output.events.forEach { event ->
                add(JsonObject().apply {
                    addProperty("runtimeId", event.runtimeId.value)
                    addProperty("generation", event.generation)
                    addProperty("sequence", event.sequence)
                    addProperty("stream", event.stream.wireName)
                    addProperty("chunk", event.chunk)
                })
            }
        })
    }

    private fun decodeOutputObject(json: JsonObject) = SessionOutputSnapshot(
        firstAvailableSequence = json.requiredLong("firstAvailableSequence"),
        nextSequence = json.requiredLong("nextSequence"),
        events = json.requiredArray("events").map { element ->
            val event = element.asJsonObject
            SessionOutputEvent(
                runtimeId = RuntimeId(event.requiredString("runtimeId")),
                generation = event.requiredLong("generation"),
                sequence = event.requiredLong("sequence"),
                stream = enumByWireName(event.requiredString("stream")),
                chunk = event.requiredString("chunk"),
            )
        },
    )

    private fun requireProtocol(json: JsonObject) {
        require(json.requiredInt("protocolVersion") == SESSION_CONTROL_PROTOCOL_VERSION) {
            "Unsupported session control protocol"
        }
    }

    private inline fun <T> decode(label: String, bytes: ByteArray, block: (JsonObject) -> T): T =
        runCatching {
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val text = decoder.decode(ByteBuffer.wrap(bytes)).toString()
            block(JsonParser.parseString(text).asJsonObject)
        }.getOrElse { error -> throw IllegalArgumentException("Invalid session $label JSON", error) }

    private fun JsonObject.toBytes(): ByteArray = toString().toByteArray(Charsets.UTF_8)

    private fun JsonObject.requiredString(name: String) = getRequired(name).asString

    private fun JsonObject.requiredLong(name: String) = getRequired(name).asLong

    private fun JsonObject.requiredInt(name: String) = getRequired(name).asInt

    private fun JsonObject.requiredBoolean(name: String) = getRequired(name).asBoolean

    private fun JsonObject.requiredObject(name: String) = getRequired(name).asJsonObject

    private fun JsonObject.requiredArray(name: String) = getRequired(name).asJsonArray

    private fun JsonObject.optionalString(name: String) = get(name)?.takeUnless { it.isJsonNull }?.asString

    private fun JsonObject.optionalLong(name: String) = get(name)?.takeUnless { it.isJsonNull }?.asLong

    private fun JsonObject.optionalBoolean(name: String) = get(name)?.takeUnless { it.isJsonNull }?.asBoolean

    private fun JsonObject.optionalObject(name: String) = get(name)?.takeUnless { it.isJsonNull }?.asJsonObject

    private fun JsonObject.optionalArray(name: String) = get(name)?.takeUnless { it.isJsonNull }?.asJsonArray

    private fun JsonObject.getRequired(name: String) = requireNotNull(get(name)) { "Missing $name" }

    private fun JsonObject.requireOnlyKeys(vararg allowed: String) {
        val allowedKeys = allowed.toSet()
        require(entrySet().all { (name, _) -> name in allowedKeys }) { "Unexpected JSON field" }
    }

    private inline fun <reified T : Enum<T>> enumByWireName(value: String): T =
        enumValues<T>().singleOrNull { candidate ->
            when (candidate) {
                is SessionCommandKind -> candidate.wireName == value
                is SessionIsolation -> candidate.wireName == value
                is SessionOutputStream -> candidate.wireName == value
                is SessionRuntimePhase -> candidate.wireName == value
                else -> false
            }
        } ?: throw IllegalArgumentException("Unknown ${T::class.java.simpleName} value")

    private fun errorByStableCode(value: String): SessionControlErrorCode =
        SessionControlErrorCode.entries.singleOrNull { error -> error.stableCode == value }
            ?: throw IllegalArgumentException("Unknown session error code")

    private companion object {
        private val COMMAND_KEYS = setOf("protocolVersion", "runtimeId", "commandId", "command")
    }
}
