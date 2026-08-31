package ai.oneworks.holonomy.session

import com.google.gson.JsonParser
import java.net.IDN
import java.net.URI
import java.security.MessageDigest
import java.util.Collections
import java.util.TreeSet

const val SESSION_CONTROL_PROTOCOL_VERSION = 2

@JvmInline
value class RuntimeId(val value: String) {
    init {
        require(SESSION_IDENTIFIER.matches(value)) { "Invalid runtimeId" }
    }

    override fun toString(): String = value
}

@JvmInline
value class CommandId(val value: String) {
    init {
        require(SESSION_IDENTIFIER.matches(value)) { "Invalid commandId" }
    }

    override fun toString(): String = value
}

enum class SessionIsolation(val wireName: String) {
    LOGICAL_RUNTIME("runtime"),
    ISOLATED_PROCESS("isolatedProcess"),
}

class SessionControlOperation(
    val operation: String,
    valueJson: String,
) {
    val valueJson: String

    init {
        require(CONTROL_OPERATION.matches(operation)) { "Invalid control operation" }
        require(valueJson.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_CONTROL_JSON_BYTES) {
            "Control JSON exceeds the session limit"
        }
        this.valueJson = runCatching { JsonParser.parseString(valueJson).toString() }
            .getOrElse { throw IllegalArgumentException("Invalid control JSON", it) }
    }

    override fun equals(other: Any?): Boolean =
        other is SessionControlOperation && operation == other.operation && valueJson == other.valueJson

    override fun hashCode(): Int = 31 * operation.hashCode() + valueJson.hashCode()

    override fun toString(): String = "SessionControlOperation(operation=$operation, valueJson=$valueJson)"
}

data class SessionModuleSpec(
    val url: String,
    val source: String,
) {
    init {
        requireAbsoluteUrl(url, "module URL")
        require(source.isNotBlank()) { "Module source must not be blank" }
        require(source.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_MODULE_BYTES) {
            "Module source exceeds the session limit"
        }
    }
}

data class SessionInspectorSpec(
    val socketName: String,
    val breakBeforeEntry: Boolean = false,
) {
    init {
        require(INSPECTOR_SOCKET.matches(socketName)) { "Invalid Inspector socket name" }
    }
}

enum class SessionSandboxNetworkAccess(val wireName: String) {
    NONE("none"),
    MOCK_ONLY("mockOnly"),
    RESTRICTED("restricted"),
}

data class SessionSandboxNetworkLimits(
    val maxChunkBytes: Int = 64 * 1024,
    val maxConcurrentConnections: Int = 8,
    val maxHeaderBytes: Int = 64 * 1024,
    val maxHeaders: Int = 128,
    val maxRequestBodyBytes: Int = 1024 * 1024,
    val maxResponseBodyBytes: Int = 8 * 1024 * 1024,
    val maxUrlBytes: Int = 64 * 1024,
    val socketTimeoutMs: Int = 30_000,
) {
    init {
        require(maxChunkBytes in 1..1024 * 1024)
        require(maxConcurrentConnections in 1..128)
        require(maxHeaderBytes in 1..1024 * 1024)
        require(maxHeaders in 1..1024)
        require(maxRequestBodyBytes in maxChunkBytes..64 * 1024 * 1024)
        require(maxResponseBodyBytes in maxChunkBytes..256 * 1024 * 1024)
        require(maxConcurrentConnections.toLong() * maxRequestBodyBytes <= 64L * 1024 * 1024)
        require(maxUrlBytes in 1..1024 * 1024)
        require(socketTimeoutMs in 1..120_000)
    }
}

class SessionSandboxNetworkPolicy(
    val access: SessionSandboxNetworkAccess = SessionSandboxNetworkAccess.NONE,
    allowedOrigins: Set<String> = emptySet(),
    allowedSchemes: Set<String> = emptySet(),
    val allowPrivateNetwork: Boolean = false,
    val limits: SessionSandboxNetworkLimits = SessionSandboxNetworkLimits(),
) {
    val allowedOrigins: Set<String> = Collections.unmodifiableSet(TreeSet(allowedOrigins))
    val allowedSchemes: Set<String> = Collections.unmodifiableSet(TreeSet(allowedSchemes))

    init {
        require(this.allowedOrigins.size <= SessionProtocolLimits.MAX_SANDBOX_ALLOWED_ORIGINS)
        when (access) {
            SessionSandboxNetworkAccess.NONE -> {
                require(this.allowedOrigins.isEmpty())
                require(this.allowedSchemes.isEmpty())
                require(!allowPrivateNetwork)
            }
            SessionSandboxNetworkAccess.MOCK_ONLY,
            SessionSandboxNetworkAccess.RESTRICTED,
            -> {
                require(this.allowedOrigins.isNotEmpty())
                require(this.allowedSchemes.isNotEmpty())
                require(this.allowedSchemes.all { it == "http" || it == "https" })
                val originSchemes = this.allowedOrigins.mapTo(linkedSetOf(), ::canonicalSandboxOriginScheme)
                require(originSchemes.all(this.allowedSchemes::contains))
            }
        }
    }

    override fun equals(other: Any?): Boolean = other is SessionSandboxNetworkPolicy &&
        access == other.access && allowedOrigins == other.allowedOrigins &&
        allowedSchemes == other.allowedSchemes && allowPrivateNetwork == other.allowPrivateNetwork &&
        limits == other.limits

    override fun hashCode(): Int = listOf(access, allowedOrigins, allowedSchemes, allowPrivateNetwork, limits).hashCode()

    override fun toString(): String = "SessionSandboxNetworkPolicy(" +
        "access=$access, allowedOrigins=$allowedOrigins, allowedSchemes=$allowedSchemes, " +
        "allowPrivateNetwork=$allowPrivateNetwork, limits=$limits)"
}

enum class SessionSandboxFilesystemAccess(val wireName: String) {
    NONE("none"),
    SANDBOXED("sandboxed"),
}

data class SessionSandboxFilesystemPolicy(
    val access: SessionSandboxFilesystemAccess = SessionSandboxFilesystemAccess.NONE,
)

data class SessionSandboxPolicy(
    val schemaVersion: Int = SANDBOX_POLICY_SCHEMA_VERSION,
    val network: SessionSandboxNetworkPolicy = SessionSandboxNetworkPolicy(),
    val filesystem: SessionSandboxFilesystemPolicy = SessionSandboxFilesystemPolicy(),
) {
    val digest: String = sandboxPolicyDigest(this)

    init {
        require(schemaVersion == SANDBOX_POLICY_SCHEMA_VERSION)
    }
}

data class SessionRuntimeSpec(
    val entryUrl: String,
    val modules: List<SessionModuleSpec>,
    val argv: List<String> = emptyList(),
    val env: Map<String, String> = emptyMap(),
    val inspector: SessionInspectorSpec? = null,
    val isolation: SessionIsolation = SessionIsolation.LOGICAL_RUNTIME,
    val initialControls: List<SessionControlOperation> = emptyList(),
    val sandboxPolicy: SessionSandboxPolicy = SessionSandboxPolicy(),
    val capabilityRuntimeJson: String? = null,
    val runtimePlugins: List<SessionRuntimePluginBundle> = emptyList(),
) {
    private val validatedCapabilityRuntime = capabilityRuntimeJson?.let { source ->
        require(source.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_CAPABILITY_RUNTIME_JSON_BYTES) {
            "Capability Runtime JSON exceeds the session limit"
        }
        runCatching { JsonParser.parseString(source) }
            .mapCatching { value -> require(value.isJsonObject); Unit }
            .getOrElse { throw IllegalArgumentException("Invalid Capability Runtime JSON", it) }
    }

    init {
        requireAbsoluteUrl(entryUrl, "entry URL")
        require(modules.isNotEmpty() && modules.size <= SessionProtocolLimits.MAX_MODULES) {
            "Invalid module count"
        }
        require(modules.map(SessionModuleSpec::url).toSet().size == modules.size) {
            "Duplicate module URL"
        }
        require(modules.any { it.url == entryUrl }) { "Entry module is missing" }
        require(
            modules.sumOf { it.source.toByteArray(Charsets.UTF_8).size.toLong() } <=
                SessionProtocolLimits.MAX_MODULE_GRAPH_BYTES,
        ) { "Module graph exceeds the session limit" }
        require(argv.size <= SessionProtocolLimits.MAX_ARGS) { "Runtime argv exceeds the session limit" }
        require(
            argv.sumOf { argument ->
                val bytes = argument.toByteArray(Charsets.UTF_8).size
                require(bytes <= SessionProtocolLimits.MAX_ARG_BYTES) { "Runtime argument exceeds the session limit" }
                bytes.toLong()
            } <= SessionProtocolLimits.MAX_ARGS_BYTES,
        ) { "Runtime argv exceeds the session limit" }
        require(env.size <= SessionProtocolLimits.MAX_ENV_ENTRIES) { "Runtime env exceeds the session limit" }
        require(
            env.entries.sumOf { (key, value) ->
                val keyBytes = key.toByteArray(Charsets.UTF_8).size
                val valueBytes = value.toByteArray(Charsets.UTF_8).size
                require(keyBytes in 1..SessionProtocolLimits.MAX_ENV_KEY_BYTES) { "Invalid runtime env key" }
                require(valueBytes <= SessionProtocolLimits.MAX_ENV_VALUE_BYTES) {
                    "Runtime env value exceeds the session limit"
                }
                (keyBytes + valueBytes).toLong()
            } <= SessionProtocolLimits.MAX_ENV_BYTES,
        ) { "Runtime env exceeds the session limit" }
        require(initialControls.size <= SessionProtocolLimits.MAX_INITIAL_CONTROLS) {
            "Too many initial runtime controls"
        }
        require(initialControls.map(SessionControlOperation::operation).toSet().size == initialControls.size) {
            "Duplicate initial runtime control"
        }
        require(runtimePlugins.size <= SessionProtocolLimits.MAX_RUNTIME_PLUGINS)
        require(runtimePlugins.map(SessionRuntimePluginBundle::instanceId).toSet().size == runtimePlugins.size)
        require(
            modules.sumOf { it.source.toByteArray(Charsets.UTF_8).size.toLong() } +
                runtimePlugins.sumOf { bundle ->
                    bundle.files.sumOf { file -> file.source.toByteArray(Charsets.UTF_8).size.toLong() }
                } <= SessionProtocolLimits.MAX_MODULE_GRAPH_BYTES,
        ) { "Runtime module and plugin graph exceeds the session limit" }
    }
}

enum class SessionCommandKind(val wireName: String) {
    CREATE("create"),
    START("start"),
    STATUS("status"),
    CANCEL("cancel"),
    STOP("stop"),
    RESTART("restart"),
    CONTROL("control"),
    DISPOSE("dispose"),
}

sealed interface SessionCommandV2 {
    val protocolVersion: Int
        get() = SESSION_CONTROL_PROTOCOL_VERSION
    val runtimeId: RuntimeId
    val commandId: CommandId
    val expectedGeneration: Long?
    val kind: SessionCommandKind
}

data class CreateRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    val spec: SessionRuntimeSpec,
) : SessionCommandV2 {
    override val expectedGeneration: Long? = null
    override val kind = SessionCommandKind.CREATE
}

data class StartRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long? = null,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.START

    init {
        validateExpectedGeneration(expectedGeneration)
    }
}

data class StatusRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long? = null,
    val afterOutputSequence: Long = 0,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.STATUS

    init {
        validateExpectedGeneration(expectedGeneration)
        require(afterOutputSequence >= 0) { "Invalid output cursor" }
    }
}

data class CancelRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long? = null,
    val reason: String? = null,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.CANCEL

    init {
        validateExpectedGeneration(expectedGeneration)
        validateReason(reason)
    }
}

data class StopRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long? = null,
    val reason: String? = null,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.STOP

    init {
        validateExpectedGeneration(expectedGeneration)
        validateReason(reason)
    }
}

data class RestartRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long? = null,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.RESTART

    init {
        validateExpectedGeneration(expectedGeneration)
    }
}

data class DisposeRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long? = null,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.DISPOSE

    init {
        validateExpectedGeneration(expectedGeneration)
    }
}

data class ControlRuntimeCommand(
    override val runtimeId: RuntimeId,
    override val commandId: CommandId,
    override val expectedGeneration: Long,
    val control: SessionControlOperation,
) : SessionCommandV2 {
    override val kind = SessionCommandKind.CONTROL

    init {
        validateExpectedGeneration(expectedGeneration)
        require(expectedGeneration > 0) { "Control command requires an active generation" }
    }
}

enum class SessionRuntimePhase(val wireName: String) {
    CREATED("created"),
    STARTING("starting"),
    RUNNING("running"),
    CANCELING("canceling"),
    CANCELED("canceled"),
    STOPPING("stopping"),
    STOPPED("stopped"),
    RESTARTING("restarting"),
    COMPLETED("completed"),
    FAILED("failed"),
    DISPOSING("disposing"),
    DISPOSED("disposed"),
}

enum class SessionOutputStream(val wireName: String) {
    NETWORK("network"),
    STDERR("stderr"),
    STDOUT("stdout"),
}

data class SessionOutputEvent(
    val runtimeId: RuntimeId,
    val generation: Long,
    val sequence: Long,
    val stream: SessionOutputStream,
    val chunk: String,
) {
    init {
        require(generation > 0 && sequence > 0)
        require(chunk.isNotEmpty())
    }
}

data class SessionOutputSnapshot(
    val firstAvailableSequence: Long,
    val nextSequence: Long,
    val events: List<SessionOutputEvent>,
) {
    init {
        require(firstAvailableSequence > 0 && nextSequence >= firstAvailableSequence)
        require(
            events.isEmpty() ||
                events.first().sequence >= firstAvailableSequence &&
                events.last().sequence + 1 == nextSequence &&
                events.zipWithNext().all { (previous, next) -> next.sequence == previous.sequence + 1 },
        ) { "Invalid output sequence window" }
    }
}

data class SessionExecutionResult(
    val runtimeId: RuntimeId,
    val generation: Long,
    val exitCode: Int,
    val reason: String? = null,
) {
    init {
        require(generation > 0)
        require(exitCode in 0..255)
        validateReason(reason)
    }
}

data class SessionRuntimeSnapshot(
    val runtimeId: RuntimeId,
    val generation: Long,
    val phase: SessionRuntimePhase,
    val isolation: SessionIsolation,
    val firstAvailableOutputSequence: Long,
    val nextOutputSequence: Long,
) {
    init {
        require(generation >= 0)
        require(firstAvailableOutputSequence > 0)
        require(nextOutputSequence >= firstAvailableOutputSequence)
    }
}

enum class SessionControlErrorCode(val stableCode: String) {
    ALREADY_EXISTS("session.runtime_already_exists"),
    COMMAND_CONFLICT("session.command_conflict"),
    GENERATION_CONFLICT("session.generation_conflict"),
    INTERNAL("session.internal"),
    INVALID_STATE("session.invalid_state"),
    ISOLATION_UNSUPPORTED("session.isolation_unsupported"),
    LIMIT_EXCEEDED("session.limit_exceeded"),
    NOT_FOUND("session.runtime_not_found"),
    SANDBOX_CAPABILITY_UNSUPPORTED("sandbox.capability_unsupported"),
}

data class SessionCommandAck(
    val protocolVersion: Int = SESSION_CONTROL_PROTOCOL_VERSION,
    val runtimeId: RuntimeId,
    val commandId: CommandId,
    val command: SessionCommandKind,
    val generation: Long,
    val accepted: Boolean,
    val errorCode: SessionControlErrorCode? = null,
) {
    init {
        require(protocolVersion == SESSION_CONTROL_PROTOCOL_VERSION)
        require(generation >= 0)
        require(accepted == (errorCode == null))
    }
}

data class SessionCommandReply(
    val ack: SessionCommandAck,
    val state: SessionRuntimeSnapshot?,
    val result: SessionExecutionResult? = null,
    val output: SessionOutputSnapshot? = null,
)

object SessionProtocolLimits {
    const val MAX_ARGS = 256
    const val MAX_ARG_BYTES = 16 * 1024
    const val MAX_ARGS_BYTES = 256 * 1024L
    const val MAX_ENV_BYTES = 1024 * 1024L
    const val MAX_ENV_ENTRIES = 256
    const val MAX_ENV_KEY_BYTES = 256
    const val MAX_ENV_VALUE_BYTES = 64 * 1024
    const val MAX_MODULE_GRAPH_BYTES = 48 * 1024 * 1024L
    const val MAX_MODULES = 512
    const val MAX_MODULE_BYTES = 8 * 1024 * 1024
    const val MAX_PLUGIN_GRAPH_BYTES = 32 * 1024 * 1024
    const val MAX_PLUGIN_FILES = 512
    const val MAX_RUNTIME_PLUGINS = 128
    const val MAX_URL_BYTES = 4 * 1024
    const val MAX_REASON_BYTES = 4 * 1024
    const val MAX_CONTROL_JSON_BYTES = 1024 * 1024
    const val MAX_CAPABILITY_RUNTIME_JSON_BYTES = 1024 * 1024
    const val MAX_INITIAL_CONTROLS = 32
    const val MAX_SANDBOX_ALLOWED_ORIGINS = 64
}

const val SANDBOX_POLICY_SCHEMA_VERSION = 1

private val INSPECTOR_SOCKET = Regex("[A-Za-z0-9._-]{1,96}")
private val SESSION_IDENTIFIER = Regex("[A-Za-z0-9._-]{1,64}")
private val CONTROL_OPERATION = Regex("[a-z][A-Za-z0-9_.-]{0,63}")

private fun requireAbsoluteUrl(value: String, label: String) {
    require(value.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_URL_BYTES) {
        "$label exceeds the session limit"
    }
    val uri = runCatching { URI(value).normalize() }.getOrNull()
    require(uri?.isAbsolute == true && !uri.scheme.isNullOrBlank() && uri.toString() == value) {
        "$label must be a canonical absolute URL"
    }
}

private fun validateExpectedGeneration(value: Long?) {
    require(value == null || value >= 0) { "Invalid expectedGeneration" }
}

private fun validateReason(value: String?) {
    require(value == null || value.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_REASON_BYTES) {
        "Reason exceeds the session limit"
    }
}

private fun canonicalSandboxOriginScheme(value: String): String {
    val (canonical, scheme) = canonicalSandboxOriginParts(value)
    val uri = URI(value)
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
    require(uri.rawPath == null || uri.rawPath.isEmpty())
    require(value == canonical) { "Network origin must be canonical" }
    return scheme
}

internal fun canonicalSandboxOrigin(value: String): String = canonicalSandboxOriginParts(value).first

private fun canonicalSandboxOriginParts(value: String): Pair<String, String> {
    require(value.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_URL_BYTES)
    val uri = URI(value)
    require(uri.isAbsolute && !uri.isOpaque && uri.rawAuthority != null)
    val scheme = requireNotNull(uri.scheme).lowercase()
    require(scheme == "http" || scheme == "https")
    val authority = requireNotNull(uri.rawAuthority).substringAfterLast('@')
    val (rawHost, rawPort, ipv6) = splitSandboxAuthority(authority)
    val host = if (ipv6) {
        "[${renderRfc5952(parseIpv6(rawHost))}]"
    } else {
        canonicalSpecialHost(rawHost)
    }
    val defaultPort = if (scheme == "https") 443 else 80
    val port = rawPort?.takeIf(String::isNotEmpty)?.let { value ->
        require(value.all(Char::isDigit))
        requireNotNull(value.toIntOrNull()).also { require(it in 0..65_535) }
    }
    val canonical = "$scheme://$host" + if (port == null || port == defaultPort) "" else ":$port"
    return canonical to scheme
}

private data class SandboxAuthority(
    val host: String,
    val port: String?,
    val ipv6: Boolean,
)

private fun splitSandboxAuthority(value: String): SandboxAuthority {
    require(value.isNotEmpty() && !value.contains('@'))
    if (value.startsWith('[')) {
        val closing = value.indexOf(']')
        require(closing > 1)
        val suffix = value.substring(closing + 1)
        require(suffix.isEmpty() || suffix.startsWith(':') && !suffix.substring(1).contains(':'))
        return SandboxAuthority(
            host = value.substring(1, closing),
            port = suffix.takeIf(String::isNotEmpty)?.substring(1),
            ipv6 = true,
        )
    }
    require(!value.contains('[') && !value.contains(']') && value.count { it == ':' } <= 1)
    val separator = value.lastIndexOf(':')
    return SandboxAuthority(
        host = if (separator < 0) value else value.substring(0, separator),
        port = if (separator < 0) null else value.substring(separator + 1),
        ipv6 = false,
    )
}

private fun canonicalSpecialHost(value: String): String {
    require(value.isNotEmpty() && !value.contains('%') && !value.contains('\\'))
    val ipv4Candidate = value.removeSuffix(".")
    val lastPiece = ipv4Candidate.substringAfterLast('.')
    val endsInNumber = lastPiece.all(Char::isDigit) || parseIpv4Number(lastPiece) != null
    if (endsInNumber) return renderIpv4(parseIpv4(ipv4Candidate))
    return IDN.toASCII(value, IDN.USE_STD3_ASCII_RULES).lowercase().also { require(it.isNotEmpty()) }
}

private fun parseIpv4(value: String): Long {
    val pieces = value.split('.')
    require(pieces.size in 1..4 && pieces.none(String::isEmpty))
    val numbers = pieces.map { requireNotNull(parseIpv4Number(it)) }
    require(numbers.dropLast(1).all { it <= 255 })
    val lastLimit = 1L shl (8 * (5 - numbers.size))
    require(numbers.last() < lastLimit)
    return numbers.dropLast(1).foldIndexed(numbers.last()) { index, address, number ->
        address + (number shl (8 * (3 - index)))
    }.also { require(it in 0..0xffff_ffffL) }
}

private fun parseIpv4Number(value: String): Long? {
    if (value.isEmpty()) return null
    val (radix, digits) = when {
        value.startsWith("0x", ignoreCase = true) -> 16 to value.substring(2)
        value.length > 1 && value.startsWith('0') -> 8 to value.substring(1)
        else -> 10 to value
    }
    if (digits.isEmpty()) return if (radix == 16) 0 else null
    val valid = when (radix) {
        8 -> digits.all { it in '0'..'7' }
        10 -> digits.all(Char::isDigit)
        else -> digits.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }
    }
    if (!valid) return null
    return digits.fold(0L) { result, character ->
        val digit = character.digitToInt(radix)
        if (result > (0xffff_ffffL - digit) / radix) return null
        result * radix + digit
    }
}

private fun renderIpv4(value: Long): String = (3 downTo 0).joinToString(".") { shift ->
    ((value shr (shift * 8)) and 0xff).toString()
}

private fun parseIpv6(value: String): IntArray {
    require(value.isNotEmpty() && !value.contains('%'))
    val compression = value.indexOf("::")
    require(compression < 0 || compression == value.lastIndexOf("::"))
    val left = if (compression < 0) value else value.substring(0, compression)
    val right = if (compression < 0) "" else value.substring(compression + 2)
    val leftPieces = parseIpv6Pieces(left)
    val rightPieces = parseIpv6Pieces(right)
    val specified = leftPieces.size + rightPieces.size
    val zeros = if (compression < 0) 0 else 8 - specified
    require(if (compression < 0) specified == 8 else zeros >= 1)
    return (leftPieces + List(zeros) { 0 } + rightPieces).toIntArray()
}

private fun parseIpv6Pieces(value: String): List<Int> {
    if (value.isEmpty()) return emptyList()
    val pieces = value.split(':')
    require(pieces.none(String::isEmpty))
    return pieces.flatMapIndexed { index, piece ->
        if (piece.contains('.')) {
            require(index == pieces.lastIndex)
            val ipv4 = piece.split('.')
            require(ipv4.size == 4)
            val octets = ipv4.map { octet ->
                require(octet.isNotEmpty() && octet.all(Char::isDigit))
                require(octet == "0" || !octet.startsWith('0'))
                requireNotNull(octet.toIntOrNull()).also { require(it in 0..255) }
            }
            listOf((octets[0] shl 8) or octets[1], (octets[2] shl 8) or octets[3])
        } else {
            require(piece.length in 1..4 && piece.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' })
            listOf(piece.toInt(16))
        }
    }
}

private fun renderRfc5952(value: IntArray): String {
    require(value.size == 8)
    var bestStart = -1
    var bestLength = 0
    var index = 0
    while (index < value.size) {
        if (value[index] != 0) {
            index += 1
            continue
        }
        val start = index
        while (index < value.size && value[index] == 0) index += 1
        val length = index - start
        if (length >= 2 && length > bestLength) {
            bestStart = start
            bestLength = length
        }
    }
    if (bestStart < 0) return value.joinToString(":") { it.toString(16) }
    val left = value.take(bestStart).joinToString(":") { it.toString(16) }
    val right = value.drop(bestStart + bestLength).joinToString(":") { it.toString(16) }
    return when {
        left.isEmpty() && right.isEmpty() -> "::"
        left.isEmpty() -> "::$right"
        right.isEmpty() -> "$left::"
        else -> "$left::$right"
    }
}

private fun sandboxPolicyDigest(policy: SessionSandboxPolicy): String {
    val canonical = buildString {
        append(policy.schemaVersion).append('\n')
        append(policy.network.access.wireName).append('\n')
        policy.network.allowedOrigins.forEach { append(it).append('\n') }
        append("--schemes--\n")
        policy.network.allowedSchemes.forEach { append(it).append('\n') }
        append(policy.network.allowPrivateNetwork).append('\n')
        with(policy.network.limits) {
            append(maxChunkBytes).append(':').append(maxConcurrentConnections).append(':')
            append(maxHeaderBytes).append(':').append(maxHeaders).append(':')
            append(maxRequestBodyBytes).append(':').append(maxResponseBodyBytes).append(':')
            append(maxUrlBytes).append(':').append(socketTimeoutMs).append('\n')
        }
        append(policy.filesystem.access.wireName)
    }
    return MessageDigest.getInstance("SHA-256")
        .digest(canonical.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xFF) }
}
