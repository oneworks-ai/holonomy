package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeHost
import java.net.InetAddress
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Generation-owned DNS admission shared by the Capability Broker Provider and Native transport.
 * The Guest receives only an opaque binding id; resolved addresses never cross the Guest boundary.
 */
class AndroidCapabilityNetworkAuthority(
    private val configuration: AndroidNetworkHostConfiguration,
    private val generation: Long,
) : AutoCloseable {
    class PolicyDeniedException internal constructor() : IllegalArgumentException()

    internal constructor(
        configuration: AndroidNetworkHostConfiguration,
        generation: Long,
        clock: () -> Long,
        lookup: (String) -> List<InetAddress>,
    ) : this(configuration, generation) {
        this.clock = clock
        this.lookup = lookup
    }

    class Evidence internal constructor(
        val addresses: List<String>,
        val expiresAtMonotonicMs: Long,
        val origin: String,
        internal val addressBytes: List<ByteArray>,
        internal val hostExpiresAtMonotonicMs: Long,
    )

    private data class Binding(
        val addresses: List<ByteArray>,
        val expiresAtMonotonicMs: Long,
        val generation: Long,
        val origin: String,
    )

    private val bindings = ConcurrentHashMap<String, Binding>()
    private val closed = AtomicBoolean(false)
    private var clock: () -> Long = { android.os.SystemClock.elapsedRealtime() }
    private var lookup: (String) -> List<InetAddress> = { host -> InetAddress.getAllByName(host).toList() }

    init {
        require(generation > 0)
    }

    fun preflight(origin: String, brokerMonotonicMs: Double): Evidence {
        check(!closed.get()) { "Network authority is closed" }
        require(brokerMonotonicMs.isFinite() && brokerMonotonicMs >= 0.0)
        val uri = URI(origin)
        require(uri.isAbsolute && uri.rawAuthority != null && uri.rawPath in listOf(null, "", "/"))
        val authorized = configuration.authorizeUrl("${origin.removeSuffix("/")}/")
        val addresses = try {
            configuration.authorizeAddresses(authorized.host, lookup(authorized.host))
        } catch (_: PrivateNetworkDeniedException) {
            throw PolicyDeniedException()
        }
        val hostExpires = Math.addExact(clock(), DNS_TTL_MS)
        val brokerExpires = brokerMonotonicMs + DNS_TTL_MS.toDouble()
        require(brokerExpires.isFinite() && brokerExpires <= MAX_SAFE_INTEGER.toDouble())
        return Evidence(
            addresses = addresses.map(::canonicalAddress).sorted(),
            expiresAtMonotonicMs = brokerExpires.toLong(),
            origin = authorized.origin,
            addressBytes = addresses.map(ByteArray::copyOf),
            hostExpiresAtMonotonicMs = hostExpires,
        )
    }

    fun bind(bindingId: String, evidence: Evidence) {
        check(!closed.get()) { "Network authority is closed" }
        require(BINDING_ID.matches(bindingId) && evidence.hostExpiresAtMonotonicMs >= clock())
        val binding = Binding(
            addresses = evidence.addressBytes.map(ByteArray::copyOf),
            expiresAtMonotonicMs = evidence.hostExpiresAtMonotonicMs,
            generation = generation,
            origin = evidence.origin,
        )
        require(bindings.putIfAbsent(bindingId, binding) == null)
    }

    fun cloneBinding(sourceBindingId: String, targetBindingId: String) {
        check(!closed.get()) { "Network authority is closed" }
        require(BINDING_ID.matches(sourceBindingId) && BINDING_ID.matches(targetBindingId))
        val source = bindings[sourceBindingId] ?: throw IllegalArgumentException("Unknown network binding")
        require(source.generation == generation && source.expiresAtMonotonicMs >= clock())
        val clone = source.copy(addresses = source.addresses.map(ByteArray::copyOf))
        require(bindings.putIfAbsent(targetBindingId, clone) == null)
    }

    internal fun resolve(bindingId: String, url: AuthorizedNetworkUrl): List<ByteArray> {
        check(!closed.get()) { "Network authority is closed" }
        val binding = bindings[bindingId] ?: throw IllegalArgumentException("Unknown network binding")
        require(binding.generation == generation && binding.origin == url.origin)
        require(clock() <= binding.expiresAtMonotonicMs)
        configuration.reauthorizeAddresses(url.host, binding.addresses)
        return binding.addresses.map(ByteArray::copyOf)
    }

    fun release(bindingId: String) {
        bindings.remove(bindingId)
    }

    fun createNativeHost(): RuntimeNativeHost = NetworkHostDependencies.createCapabilityProvider(
        configuration,
        AndroidNetworkObservationConfiguration(),
        AndroidNetworkProviderGeneration("capability-network", generation),
        this,
    )

    override fun close() {
        if (closed.compareAndSet(false, true)) bindings.clear()
    }

    private companion object {
        const val DNS_TTL_MS = 30_000L
        const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
        val BINDING_ID = Regex("^[A-Za-z0-9:._-]{1,256}$")

        fun canonicalAddress(bytes: ByteArray): String = when (bytes.size) {
            4 -> bytes.joinToString(".") { byte -> (byte.toInt() and 0xff).toString() }
            16 -> canonicalIpv6(bytes)
            else -> throw IllegalArgumentException("Unsupported network address")
        }

        fun canonicalIpv6(bytes: ByteArray): String {
            val words = IntArray(8) { index ->
                ((bytes[index * 2].toInt() and 0xff) shl 8) or (bytes[index * 2 + 1].toInt() and 0xff)
            }
            var bestStart = -1
            var bestLength = 0
            var start = 0
            while (start < words.size) {
                if (words[start] != 0) {
                    start += 1
                    continue
                }
                var end = start
                while (end < words.size && words[end] == 0) end += 1
                if (end - start > bestLength && end - start >= 2) {
                    bestStart = start
                    bestLength = end - start
                }
                start = end
            }
            if (bestStart < 0) return words.joinToString(":") { it.toString(16) }
            val before = words.take(bestStart).joinToString(":") { it.toString(16) }
            val after = words.drop(bestStart + bestLength).joinToString(":") { it.toString(16) }
            return when {
                before.isEmpty() && after.isEmpty() -> "::"
                before.isEmpty() -> "::$after"
                after.isEmpty() -> "$before::"
                else -> "$before::$after"
            }
        }
    }
}
