package ai.oneworks.holonomy.network

import java.net.IDN
import java.net.InetAddress
import java.net.URI

class AndroidNetworkHostConfiguration(
    principal: String,
    allowedOrigins: Set<String>,
    allowedSchemes: Set<String> = setOf("http", "https"),
    val privateNetwork: PrivateNetworkPolicy = PrivateNetworkPolicy.DENY,
    val limits: AndroidNetworkLimits = AndroidNetworkLimits(),
) {
    val principal: String = principal
    val allowedOrigins: Set<String> = allowedOrigins.toSet()
    val allowedSchemes: Set<String> = allowedSchemes.toSet()

    private val allowAnyOrigin = "*" in this.allowedOrigins
    private val normalizedOrigins = this.allowedOrigins
        .filter { it != "*" }
        .mapTo(linkedSetOf(), ::normalizeConfiguredOrigin)

    init {
        require(PRINCIPAL.matches(this.principal))
        require(this.allowedOrigins.isNotEmpty() && this.allowedOrigins.size <= limits.maxAllowedOrigins)
        require(this.allowedOrigins.count { it == "*" } <= 1)
        require(this.allowedSchemes.isNotEmpty())
        require(this.allowedSchemes.all { it == "http" || it == "https" })
        require(normalizedOrigins.size == this.allowedOrigins.count { it != "*" })
    }

    internal fun authorizeUrl(value: String): AuthorizedNetworkUrl {
        require(value.toByteArray(Charsets.UTF_8).size <= limits.maxUrlBytes)
        require(!hasInvalidHttpText(value))
        val uri = URI(value)
        require(uri.isAbsolute && !uri.isOpaque && uri.rawAuthority != null)
        require(uri.rawUserInfo == null && uri.rawFragment == null)
        val scheme = uri.scheme?.lowercase() ?: throw IllegalArgumentException()
        require(uri.scheme == scheme && scheme in allowedSchemes)
        val host = normalizeHost(uri.host ?: throw IllegalArgumentException())
        val port = normalizedPort(scheme, uri.port)
        require(uri.port == -1 || uri.port != defaultPort(scheme))
        require(uri.rawPath?.startsWith('/') == true)
        require(uri.normalize().toASCIIString() == value)
        val origin = origin(scheme, host, port)
        require(allowAnyOrigin || origin in normalizedOrigins)
        val requestTarget = uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: "")
        return AuthorizedNetworkUrl(
            host = host,
            hostHeader = renderAuthority(host, port, port != defaultPort(scheme)),
            origin = origin,
            port = port,
            raw = value,
            requestTarget = requestTarget,
            scheme = scheme,
        )
    }

    internal fun authorizeAddresses(host: String, addresses: List<InetAddress>): List<ByteArray> {
        require(addresses.isNotEmpty() && addresses.size <= MAX_RESOLVED_ADDRESSES)
        if (privateNetwork == PrivateNetworkPolicy.DENY) {
            require(host != "localhost" && !host.endsWith(".localhost"))
        }
        return addresses.map { address ->
            val bytes = address.address.copyOf()
            require(bytes.size == 4 || bytes.size == 16)
            if (privateNetwork == PrivateNetworkPolicy.DENY) require(isPublicAddress(bytes))
            bytes
        }
    }

    internal fun reauthorizeAddresses(host: String, addresses: List<ByteArray>) {
        require(addresses.isNotEmpty() && addresses.size <= MAX_RESOLVED_ADDRESSES)
        if (privateNetwork == PrivateNetworkPolicy.DENY) {
            require(host != "localhost" && !host.endsWith(".localhost"))
            require(addresses.all(::isPublicAddress))
        } else {
            require(addresses.all { it.size == 4 || it.size == 16 })
        }
    }

    private fun normalizeConfiguredOrigin(value: String): String {
        val uri = URI(value)
        require(uri.isAbsolute && !uri.isOpaque && uri.rawAuthority != null)
        require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
        require(uri.rawPath == null || uri.rawPath == "" || uri.rawPath == "/")
        val scheme = uri.scheme?.lowercase() ?: throw IllegalArgumentException()
        require(uri.scheme == scheme && scheme in allowedSchemes)
        val host = normalizeHost(uri.host ?: throw IllegalArgumentException())
        val port = normalizedPort(scheme, uri.port)
        require(uri.port == -1 || uri.port != defaultPort(scheme))
        return origin(scheme, host, port)
    }

    companion object {
        private const val MAX_RESOLVED_ADDRESSES = 16
        private val PRINCIPAL = Regex("^[A-Za-z0-9:._-]{1,128}$")

        private fun defaultPort(scheme: String): Int = if (scheme == "https") 443 else 80

        private fun normalizedPort(scheme: String, port: Int): Int {
            require(port == -1 || port in 1..65_535)
            return if (port == -1) defaultPort(scheme) else port
        }

        private fun normalizeHost(value: String): String {
            val unwrapped = value.removePrefix("[").removeSuffix("]").removeSuffix(".")
            require(unwrapped.isNotEmpty() && !unwrapped.contains('%'))
            return if (unwrapped.contains(':')) {
                unwrapped.lowercase()
            } else {
                IDN.toASCII(unwrapped, IDN.USE_STD3_ASCII_RULES).lowercase()
            }
        }

        private fun origin(scheme: String, host: String, port: Int): String {
            return "$scheme://${renderAuthority(host, port, true)}"
        }

        private fun renderAuthority(host: String, port: Int, includePort: Boolean): String {
            val renderedHost = if (host.contains(':')) "[$host]" else host
            return if (includePort) "$renderedHost:$port" else renderedHost
        }

        private fun isPublicAddress(bytes: ByteArray): Boolean = when (bytes.size) {
            4 -> isPublicIpv4(bytes)
            16 -> isPublicIpv6(bytes)
            else -> false
        }

        private fun isPublicIpv4(bytes: ByteArray): Boolean {
            val value = bytes.fold(0L) { current, byte -> (current shl 8) or (byte.toInt() and 0xFF).toLong() }
            return IPV4_DENY.none { prefix -> prefix.matches(value) }
        }

        private fun isPublicIpv6(bytes: ByteArray): Boolean {
            if ((bytes[0].toInt() and 0xE0) != 0x20) return false
            return IPV6_DENY.none { prefix -> prefix.matches(bytes) }
        }

        private val IPV4_DENY = listOf(
            Ipv4Prefix("0.0.0.0", 8),
            Ipv4Prefix("10.0.0.0", 8),
            Ipv4Prefix("100.64.0.0", 10),
            Ipv4Prefix("127.0.0.0", 8),
            Ipv4Prefix("169.254.0.0", 16),
            Ipv4Prefix("172.16.0.0", 12),
            Ipv4Prefix("192.0.0.0", 24),
            Ipv4Prefix("192.0.2.0", 24),
            Ipv4Prefix("192.88.99.0", 24),
            Ipv4Prefix("192.168.0.0", 16),
            Ipv4Prefix("198.18.0.0", 15),
            Ipv4Prefix("198.51.100.0", 24),
            Ipv4Prefix("203.0.113.0", 24),
            Ipv4Prefix("224.0.0.0", 4),
            Ipv4Prefix("240.0.0.0", 4),
        )

        private val IPV6_DENY = listOf(
            Ipv6Prefix("::", 128),
            Ipv6Prefix("::1", 128),
            Ipv6Prefix("::ffff:0:0", 96),
            Ipv6Prefix("64:ff9b::", 96),
            Ipv6Prefix("64:ff9b:1::", 48),
            Ipv6Prefix("100::", 64),
            Ipv6Prefix("100:0:0:1::", 64),
            Ipv6Prefix("2001::", 23),
            Ipv6Prefix("2001:2::", 48),
            Ipv6Prefix("2001:3::", 32),
            Ipv6Prefix("2001:4:112::", 48),
            Ipv6Prefix("2001:10::", 28),
            Ipv6Prefix("2001:20::", 28),
            Ipv6Prefix("2001:30::", 28),
            Ipv6Prefix("2001:db8::", 32),
            Ipv6Prefix("2002::", 16),
            Ipv6Prefix("2620:4f:8000::", 48),
            Ipv6Prefix("3fff::", 20),
            Ipv6Prefix("5f00::", 16),
            Ipv6Prefix("fc00::", 7),
            Ipv6Prefix("fe80::", 10),
            Ipv6Prefix("ff00::", 8),
        )
    }
}

internal data class AuthorizedNetworkUrl(
    val host: String,
    val hostHeader: String,
    val origin: String,
    val port: Int,
    val raw: String,
    val requestTarget: String,
    val scheme: String,
)

data class AndroidNetworkLimits(
    val maxAllowedOrigins: Int = 128,
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
        require(maxAllowedOrigins in 1..1024)
        require(maxChunkBytes in 1..1024 * 1024)
        require(maxConcurrentConnections in 1..128)
        require(maxHeaderBytes in 1..1024 * 1024)
        require(maxHeaders in 1..1024)
        require(maxRequestBodyBytes in maxChunkBytes..MAX_BUFFERED_REQUEST_BYTES)
        require(maxResponseBodyBytes in maxChunkBytes..MAX_RESPONSE_BYTES)
        require(maxConcurrentConnections.toLong() * maxRequestBodyBytes <= MAX_AGGREGATE_REQUEST_BYTES)
        require(maxUrlBytes in 1..1024 * 1024)
        require(socketTimeoutMs in 1..120_000)
    }

    private companion object {
        private const val MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024
        private const val MAX_AGGREGATE_REQUEST_BYTES = 64L * 1024 * 1024
        private const val MAX_RESPONSE_BYTES = 256 * 1024 * 1024
    }
}

enum class PrivateNetworkPolicy {
    ALLOW,
    DENY,
}

private data class Ipv4Prefix(
    private val base: Long,
    private val bits: Int,
) {
    constructor(value: String, bits: Int) : this(
        value.split('.').fold(0L) { current, part -> (current shl 8) or part.toLong() },
        bits,
    )

    fun matches(value: Long): Boolean {
        val mask = if (bits == 0) 0L else (0xFFFF_FFFFL shl (32 - bits)) and 0xFFFF_FFFFL
        return value and mask == base and mask
    }
}

private data class Ipv6Prefix(
    private val base: ByteArray,
    private val bits: Int,
) {
    constructor(value: String, bits: Int) : this(InetAddress.getByName(value).address, bits)

    fun matches(value: ByteArray): Boolean {
        if (value.size != 16 || base.size != 16) return false
        val complete = bits / 8
        for (index in 0 until complete) if (value[index] != base[index]) return false
        val remaining = bits % 8
        if (remaining == 0) return true
        val mask = (0xFF shl (8 - remaining)) and 0xFF
        return (value[complete].toInt() and mask) == (base[complete].toInt() and mask)
    }
}

internal fun hasInvalidHttpText(value: String): Boolean = value.any { character ->
    val code = character.code
    code == 0 || code in 1..8 || code in 10..31 || code == 127
}
