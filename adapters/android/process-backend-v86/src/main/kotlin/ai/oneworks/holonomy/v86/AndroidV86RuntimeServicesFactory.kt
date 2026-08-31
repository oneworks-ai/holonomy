package ai.oneworks.holonomy.v86

import android.content.Context
import ai.oneworks.holonomy.capability.AndroidCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityServices
import ai.oneworks.holonomy.host.RuntimeCapabilityServicesFactory
import ai.oneworks.holonomy.network.AndroidCapabilityNetworkAuthority
import ai.oneworks.holonomy.network.AndroidNetworkHostConfiguration
import ai.oneworks.holonomy.network.AndroidNetworkLimits
import ai.oneworks.holonomy.network.PrivateNetworkPolicy
import com.caoccao.javet.interop.options.V8RuntimeOptions
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject

/**
 * Optional production integration. A sandboxed Process policy selects v86 automatically;
 * a disabled Process policy neither loads Backend assets nor creates a second V8 Runtime.
 */
class AndroidV86RuntimeServicesFactory(
    applicationContext: Context,
    private val configurationJson: String,
    private val processId: String,
    private val generation: Long,
    private val principal: String,
    private val expectedNetworkProvider: String,
    private val networkTransportFactory: (() -> AndroidV86NetworkTransport)? = null,
    private val capabilityDomains: Set<String> = emptySet(),
    private val backendDiagnostics: Boolean = false,
    private val backendStartupTimeoutMs: Long = 300_000L,
) : RuntimeCapabilityServicesFactory {
    private val context = applicationContext.applicationContext

    init {
        require(backendStartupTimeoutMs in 1..600_000)
    }

    override fun create(): RuntimeCapabilityServices {
        val envelope = JSONObject(configurationJson)
        require(envelope.getLong("generation") == generation)
        val session = envelope.getJSONObject("session")
        require(session.getString("processId") == processId)
        val runtimeConfiguration = session.getJSONObject("runtimeCreation").getJSONObject("configuration")
        val network = createNetworkServices(runtimeConfiguration)
        val processPolicy = runtimeConfiguration.getJSONObject("sandboxPolicy").getJSONObject("process")
        if (processPolicy.getString("access") == "none") {
            return RuntimeCapabilityServices(
                capabilityHost = capabilityHost(network.authority),
                nativeHost = network.nativeHost,
            )
        }
        require(processPolicy.getString("access") == "sandboxed")
        val processNetwork = processPolicy.getJSONObject("network")
        val effectiveNetworkTransport = if (processNetwork.getString("access") == "restricted") {
            networkTransportFactory?.invoke() ?: AndroidV86HostNetworkTransport(
                allowPrivateNetwork = processNetwork.optString("privateNetwork", "deny") == "allow",
                maxSockets = processNetwork.getInt("maxSockets"),
            )
        } else {
            null
        }
        val profile = session.getJSONObject("providerConfiguration").getJSONObject("processProfile")
        val backendConfiguration = profile.getJSONObject("backend").also { backend ->
            require(backend.getString("backendId") == BACKEND_ID)
        }.getJSONObject("configuration")
        val assets = AndroidV86AssetStore(context.assets)
        assets.requireBackend(backendConfiguration, profile)
        AndroidV86ProcessBackendFeature.enable()
        val sink = AtomicReference<AndroidV86ProcessEventSink>()
        val environment = profile.getJSONObject("environment")
        val baseBackendConfiguration = JSONObject()
                .put("generation", generation)
                .put("memoryBytes", backendConfiguration.getInt("memoryBytes"))
                .put("startupTimeoutMs", backendStartupTimeoutMs)
                .put("network", effectiveNetworkTransport != null)
                .put("policy", processPolicy)
                .put("capabilityDomains", JSONArray(validCapabilityDomains()))
                .put("diagnostics", backendDiagnostics)
                .put("execGateTimeoutMs", backendConfiguration.getJSONObject("supervisor").optInt("execGateTimeoutMs", 30_000))
                .put("executables", processExecutables(profile))
                .put("hosts", environmentHosts(processPolicy))
                .put("requiredKernelCapabilities", backendConfiguration.getJSONArray("requiredKernelCapabilities"))
        val backend = AndroidV86EnvironmentManager(
            processId = processId,
            generation = generation,
            defaultScope = environment.getString("defaultScope"),
            startupTimeoutMs = backendStartupTimeoutMs,
            eventSink = AndroidV86ProcessEventSink { event -> sink.get()?.emit(event) },
            networkTransport = effectiveNetworkTransport,
            backendFactory = { environmentId, scope, eventSink ->
                AndroidV86ProcessBackend(
                    assetStore = assets,
                    configuration = JSONObject(baseBackendConfiguration.toString())
                        .put("environmentId", environmentId)
                        .put("scope", scope),
                    eventSink = eventSink,
                    networkTransport = effectiveNetworkTransport,
                    ownsNetworkTransport = false,
                )
            },
        )
        val provider = AndroidV86ProcessProvider(
            generation,
            processPolicy,
            profile,
            backend,
            networkTransport = effectiveNetworkTransport,
            diagnostics = backendDiagnostics,
        )
        sink.set(provider)
        return RuntimeCapabilityServices(
            capabilityHost = capabilityHost(network.authority, provider),
            nativeHost = network.nativeHost,
            trustedBackend = backend,
        )
    }

    private fun capabilityHost(
        networkAuthority: AndroidCapabilityNetworkAuthority?,
        processProvider: AndroidV86ProcessProvider? = null,
    ) = AndroidCapabilityHost(
        applicationContext = context,
        configurationJson = configurationJson,
        processId = processId,
        generation = generation,
        expectedNetworkProvider = expectedNetworkProvider,
        processProvider = processProvider,
        networkAuthority = networkAuthority,
        diagnostics = backendDiagnostics,
    )

    private fun createNetworkServices(runtimeConfiguration: JSONObject): NetworkServices {
        val policy = runtimeConfiguration.getJSONObject("sandboxPolicy").getJSONObject("network")
        if (policy.getString("access") != "restricted") {
            return NetworkServices(null, null)
        }
        val limits = policy.getJSONObject("limits")
        val configuration = AndroidNetworkHostConfiguration(
            principal = principal,
            allowedOrigins = policy.getJSONArray("allowedOrigins").strings(),
            allowedSchemes = policy.getJSONArray("allowedSchemes").strings(),
            privateNetwork = if (policy.getBoolean("allowPrivateNetwork")) {
                PrivateNetworkPolicy.ALLOW
            } else {
                PrivateNetworkPolicy.DENY
            },
            limits = AndroidNetworkLimits(
                maxChunkBytes = limits.getInt("maxChunkBytes"),
                maxConcurrentConnections = limits.getInt("maxConcurrentConnections"),
                maxHeaderBytes = limits.getInt("maxHeaderBytes"),
                maxHeaders = limits.getInt("maxHeaders"),
                maxRequestBodyBytes = limits.getInt("maxRequestBodyBytes"),
                maxResponseBodyBytes = limits.getInt("maxResponseBodyBytes"),
                maxUrlBytes = limits.getInt("maxUrlBytes"),
                socketTimeoutMs = limits.getInt("socketTimeoutMs"),
            ),
        )
        val authority = AndroidCapabilityNetworkAuthority(configuration, generation)
        return NetworkServices(authority, authority.createNativeHost())
    }

    private data class NetworkServices(
        val authority: AndroidCapabilityNetworkAuthority?,
        val nativeHost: ai.oneworks.holonomy.host.RuntimeNativeHost?,
    )

    private fun org.json.JSONArray.strings(): Set<String> =
        (0 until length()).mapTo(linkedSetOf()) { index -> getString(index) }

    private fun validCapabilityDomains(): List<String> {
        require(capabilityDomains.all { value -> value == "device" || value == "system" })
        return capabilityDomains.sorted()
    }

    private fun processExecutables(profile: JSONObject): JSONArray = JSONArray().also { output ->
        profile.getJSONArray("executables").objects().forEach { item ->
            val executable = item.getJSONObject("executable")
            require(executable.getString("kind") == "guestPath")
            output.put(
                JSONObject()
                    .put("executableId", item.getString("executableId"))
                    .put("path", executable.getString("path"))
                    .put("shell", item.getBoolean("shell")),
            )
        }
    }

    private fun environmentHosts(policy: JSONObject): JSONArray {
        val network = policy.getJSONObject("network")
        if (network.getString("access") != "restricted") return JSONArray()
        val hostnames = network.getJSONArray("endpoints").objects()
            .map { item -> item.getString("hostname") }
            .filterNot(::isIpv4)
            .filterNot { value -> value == "localhost" }
            .distinct()
            .sorted()
        require(hostnames.size <= 256)
        return JSONArray().also { output ->
            hostnames.forEachIndexed { index, hostname ->
                output.put(
                    JSONObject()
                        .put("address", "192.168.${87 + index / 254}.${index % 254 + 1}")
                        .put("hostname", hostname),
                )
            }
        }
    }

    private fun isIpv4(value: String): Boolean {
        val parts = value.split('.')
        return parts.size == 4 && parts.all { part ->
            part.toIntOrNull()?.let { number -> number in 0..255 && number.toString() == part } == true
        }
    }

    private fun org.json.JSONArray.objects(): List<JSONObject> =
        (0 until length()).map { index -> getJSONObject(index) }

    companion object {
        const val BACKEND_ID = "experimental.v86-v1"
    }
}

/** Process-wide V8 options must be fixed before the first isolate is constructed. */
object AndroidV86ProcessBackendFeature {
    private val configured = AtomicBoolean(false)

    fun enable() {
        if (configured.compareAndSet(false, true)) V8RuntimeOptions.V8_FLAGS.setCustomFlags(V8_FLAGS)
    }

    private const val V8_FLAGS =
        "--liftoff-only --no-wasm-tier-up --no-wasm-dynamic-tiering --wasm-num-compilation-tasks=1"
}
