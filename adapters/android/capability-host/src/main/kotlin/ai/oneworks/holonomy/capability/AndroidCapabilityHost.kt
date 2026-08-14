package ai.oneworks.holonomy.capability

import android.content.Context
import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/** Production Android Provider host for RFC-0001 M3 capabilities. */
class AndroidCapabilityHost(
    applicationContext: Context,
    configurationJson: String,
    private val processId: String,
    private val generation: Long,
    expectedNetworkProvider: String,
) : RuntimeCapabilityHost {
    private val closed = AtomicBoolean(false)
    private val resources = CapabilityResourceStore()
    private val configuration = normalizedConfiguration(configurationJson, expectedNetworkProvider)
    private val runtimeConfiguration = configuration.getJSONObject("session")
        .getJSONObject("runtimeCreation")
        .getJSONObject("configuration")
    private val filesystem = AndroidFilesystemProvider(
        File(applicationContext.filesDir, "capability-workspaces/$processId"),
        generation,
        resources,
    )
    private val system = AndroidSystemProvider(runtimeConfiguration.getJSONObject("systemProjection"))
    private val device = AndroidDeviceProvider(
        applicationContext.applicationContext,
        generation,
        runtimeConfiguration.getJSONObject("deviceProviderDescriptor"),
        resources,
    )

    override fun configurationJson(): String {
        check(!closed.get()) { "Capability host is closed" }
        return configuration.toString()
    }

    override fun invokeSync(requestJson: String): String {
        if (closed.get()) return failure("runtime.generation_stale")
        return runCatching {
            val request = JSONObject(requestJson)
            request.requireCapabilityRequest()
            require(request.getLong("generation") == generation)
            when (request.getString("providerModule")) {
                "host.fs" -> filesystem.invoke(request)
                "host.system" -> system.invoke(request)
                "host.device" -> device.invoke(request)
                "host.network", "host.network.mock" -> network(request)
                "host.process" -> process(request)
                else -> throw ProviderFailure("capability.denied")
            }
        }.getOrElse { error ->
            failure((error as? ProviderFailure)?.code ?: "provider.unavailable")
        }
    }

    override fun subscribeResource(bindingId: String, sink: RuntimeCapabilityResourceEventSink): AutoCloseable? =
        if (closed.get()) null else resources.subscribe(bindingId, sink)

    override fun releaseResource(bindingId: String) = resources.release(bindingId)

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        resources.close()
    }

    private fun normalizedConfiguration(source: String, networkProvider: String): JSONObject {
        val envelope = JSONObject(source).apply { requireOnlyKeys("generation", "session") }
        require(envelope.getLong("generation") == generation)
        val session = envelope.getJSONObject("session")
        require(session.getString("processId") == processId)
        val configured = session.getJSONObject("providerConfiguration").getString("networkProvider")
        require(configured == networkProvider && configured in setOf("host.network", "host.network.mock"))
        return JSONObject(envelope.toString())
    }

    private fun network(request: JSONObject): String {
        val module = request.getString("providerModule")
        val resource = request.getJSONObject("resource")
        require(resource.getString("kind") == "network")
        val expectedMode = if (module == "host.network.mock") "mockOnly" else "restricted"
        val origin = resource.getString("origin")
        val scheme = origin.substringBefore(":")
        val authorized = request.getJSONArray("authorityBindings").objects().any { binding ->
            if (binding.getString("providerModule") != module) return@any false
            val constraints = binding.getJSONObject("constraints")
            constraints.getString("mode") == expectedMode &&
                constraints.getJSONArray("origins").strings().contains(origin) &&
                constraints.getJSONArray("schemes").strings().contains(scheme)
        }
        if (!authorized) throw ProviderFailure("capability.denied")
        when (request.getString("operation")) {
            "network.fetch.redirect" -> return success(JSONObject())
            "network.response.metadata.read" -> return success(request.getJSONObject("providerData"))
            "network.response.body.read" -> {
                if (request.getString("member") == "Response.clone") {
                    val bindingId = request.getString("inheritedBindingId")
                    return success(
                        JSONObject()
                            .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
                            .put("resourceType", "network.response"),
                    )
                }
                val value: Any = when (request.getString("member")) {
                    "Response.json" -> JSONObject.NULL
                    "Response.text" -> ""
                    else -> JSONObject()
                        .put("base64", "")
                        .put("byteLength", 0)
                        .put("sha256", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
                }
                return success(value)
            }
        }
        val bindingId = "android-network-${resource.getString("semanticResourceDigest").take(24)}"
        return success(
            JSONObject()
                .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
                .put("resourceType", "network.response"),
            listOf(resourcePublication(bindingId, "network.response")),
        )
    }

    private fun process(request: JSONObject): String {
        val resource = request.getJSONObject("resource")
        require(
            request.getString("operation") == "process.network.connect" &&
                resource.getString("kind") == "processNetworkEndpoint",
        )
        val authorized = request.getJSONArray("authorityBindings").objects().any { binding ->
            if (
                binding.getString("providerModule") != "host.process" ||
                binding.getString("capabilityName") != "host.process.network"
            ) return@any false
            val constraints = binding.getJSONObject("constraints")
            constraints.getInt("maxSockets") > 0 && constraints.getJSONArray("endpoints").objects().any { endpoint ->
                val ports = endpoint.getJSONArray("ports")
                endpoint.getString("hostname") == resource.getString("hostname") &&
                    endpoint.getString("transport") == resource.getString("transport") &&
                    (0 until ports.length()).any { index -> ports.getInt(index) == resource.getInt("port") }
            }
        }
        if (!authorized) throw ProviderFailure("capability.denied")
        val binding = request.getJSONObject("invocationBinding")
        require(
            binding.getLong("generation") == generation &&
                binding.getString("semanticResourceDigest") == resource.getString("semanticResourceDigest"),
        )
        return success(
            JSONObject()
                .put("authorized", true)
                .put("generation", generation)
                .put("invocationBindingDigest", binding.getString("invocationBindingDigest"))
                .put("semanticResourceDigest", resource.getString("semanticResourceDigest")),
        )
    }

    private fun JSONObject.requireCapabilityRequest() {
        val allowed = setOf(
            "arguments",
            "authorityBindings",
            "generation",
            "inheritedBindingId",
            "invocationBinding",
            "invocationMode",
            "member",
            "module",
            "operation",
            "providerData",
            "providerModule",
            "resource",
            "source",
        )
        val required = allowed - setOf("inheritedBindingId", "providerData", "source")
        require(keys().asSequence().all(allowed::contains) && required.all(::has))
    }
}
