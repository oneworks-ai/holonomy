package ai.oneworks.holonomy.capability

import android.content.Context
import android.util.Log
import ai.oneworks.holonomy.host.RuntimeCapabilityHost
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import ai.oneworks.holonomy.network.AndroidCapabilityNetworkAuthority
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

/** Production Android Provider host for RFC-0001 M3 capabilities. */
class AndroidCapabilityHost(
    applicationContext: Context,
    configurationJson: String,
    private val processId: String,
    private val generation: Long,
    expectedNetworkProvider: String,
    private val processProvider: AndroidProcessCapabilityProvider? = null,
    private val networkAuthority: AndroidCapabilityNetworkAuthority? = null,
    deviceObservationSource: AndroidDeviceObservationSource? = null,
    deviceValueSource: AndroidDeviceValueSource? = null,
    private val diagnostics: Boolean = false,
) : RuntimeCapabilityHost {
    private val closed = AtomicBoolean(false)
    private val resources = CapabilityResourceStore()
    private val networkPreflights = ConcurrentHashMap<String, AndroidCapabilityNetworkAuthority.Evidence>()
    private val nextNetworkBinding = AtomicLong(1)
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
        deviceObservationSource ?: AndroidDeviceObservationSource.platform(applicationContext),
        deviceValueSource,
    )

    override fun configurationJson(): String {
        check(!closed.get()) { "Capability host is closed" }
        return configuration.toString()
    }

    override fun invokeSync(requestJson: String): String {
        if (closed.get()) return failure("runtime.generation_stale")
        var providerModule = "invalid"
        var operation = "invalid"
        return runCatching {
            val request = JSONObject(requestJson)
            request.requireCapabilityRequest()
            require(request.getLong("generation") == generation)
            providerModule = request.getString("providerModule")
            operation = request.getString("operation")
            when (providerModule) {
                "host.fs" -> filesystem.invoke(request)
                "host.system" -> system.invoke(request)
                "host.device" -> device.invoke(request)
                "host.network", "host.network.mock" -> network(request)
                "host.process" -> processProvider?.invoke(request.toString()) ?: process(request)
                else -> throw ProviderFailure("capability.denied")
            }
        }.onSuccess {
            if (diagnostics) Log.d(TAG, "Provider $providerModule operation $operation completed")
        }.getOrElse { error ->
            val code = (error as? ProviderFailure)?.code ?: "provider.unavailable"
            if (diagnostics) {
                Log.d(TAG, "Provider $providerModule operation $operation failed code=$code type=${error.javaClass.simpleName}")
            }
            failure(code)
        }
    }

    override fun subscribeResource(bindingId: String, sink: RuntimeCapabilityResourceEventSink): AutoCloseable? =
        if (closed.get()) {
            null
        } else if (processProvider?.ownsResource(bindingId) == true) {
            processProvider.subscribeResource(bindingId, sink)
        } else {
            resources.subscribe(bindingId, sink)
        }

    override fun releaseResource(bindingId: String) {
        if (processProvider?.ownsResource(bindingId) == true) processProvider.releaseResource(bindingId)
        else resources.release(bindingId)
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { processProvider?.close() }
        networkPreflights.clear()
        resources.close()
        runCatching { networkAuthority?.close() }
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
        val phase = request.optString("providerPhase").takeIf(String::isNotEmpty)
        if (module == "host.network" && request.getString("operation") == "network.fetch.request") {
            when (phase) {
                "preflight" -> return networkPreflight(request, resource, origin)
                "verify" -> return networkVerify(request, resource)
                "cancel" -> {
                    networkPreflights.remove(request.getString("requestId"))
                    return success(JSONObject())
                }
                "execute" -> return completeNetworkRequest(request, resource)
                null -> if (networkAuthority != null) throw ProviderFailure("provider.protocol_error")
                else -> throw ProviderFailure("provider.protocol_error")
            }
        }
        when (request.getString("operation")) {
            "network.fetch.redirect" -> return success(JSONObject())
            "network.response.metadata.read" -> return success(request.getJSONObject("providerData"))
            "network.response.body.read" -> {
                if (request.getString("member") == "Response.clone") {
                    return completeNetworkClone(request)
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
        return completeNetworkRequest(request, resource)
    }

    private fun completeNetworkClone(request: JSONObject): String {
        val sourceBindingId = request.getString("inheritedBindingId")
        val bindingId = "android-network-clone-${generation}-${nextNetworkBinding.getAndIncrement()}"
        if (networkAuthority != null) {
            val authority = networkAuthority
            runCatching { authority.cloneBinding(sourceBindingId, bindingId) }
                .getOrElse { throw ProviderFailure("resource.stale") }
            resources.publish(bindingId, NetworkCapabilityResource(authority, bindingId))
        }
        return success(
            JSONObject()
                .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
                .put("resourceType", "network.response"),
            listOf(resourcePublication(bindingId, "network.response")),
        )
    }

    private fun networkPreflight(request: JSONObject, resource: JSONObject, origin: String): String {
        val authority = networkAuthority ?: throw ProviderFailure("provider.unavailable")
        val requestId = request.getString("requestId")
        val evidence = try {
            authority.preflight(origin, request.getDouble("brokerMonotonicMs"))
        } catch (_: AndroidCapabilityNetworkAuthority.PolicyDeniedException) {
            throw ProviderFailure("policy.denied")
        } catch (_: Exception) {
            throw ProviderFailure("provider.unavailable")
        }
        if (networkPreflights.putIfAbsent(requestId, evidence) != null) {
            throw ProviderFailure("provider.protocol_error")
        }
        val evidenceJson = networkEvidence(evidence)
        return success(
            JSONObject().put(
                "requests",
                org.json.JSONArray().put(
                    JSONObject()
                        .put("evidence", evidenceJson)
                        .put("reason", "networkAddress")
                        .put("resolved", JSONObject(resource.toString()))
                        .put("sideEffectCount", 0),
                ),
            ),
        )
    }

    private fun networkVerify(request: JSONObject, resource: JSONObject): String {
        val evidence = networkPreflights[request.getString("requestId")]
            ?: throw ProviderFailure("resource.stale")
        return success(
            JSONObject()
                .put("evidence", networkEvidence(evidence))
                .put("resolved", JSONObject(resource.toString())),
        )
    }

    private fun completeNetworkRequest(request: JSONObject, resource: JSONObject): String {
        val evidence = if (networkAuthority == null) {
            null
        } else {
            validateNetworkExecution(request, resource)
        }
        val bindingId = "android-network-${generation}-${nextNetworkBinding.getAndIncrement()}"
        if (evidence != null) {
            val authority = requireNotNull(networkAuthority)
            runCatching { authority.bind(bindingId, evidence) }
                .getOrElse { throw ProviderFailure("provider.protocol_error") }
            resources.publish(bindingId, NetworkCapabilityResource(authority, bindingId))
        }
        return success(
            JSONObject()
                .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
                .put("resourceType", "network.response"),
            listOf(resourcePublication(bindingId, "network.response")),
        )
    }

    private fun validateNetworkExecution(request: JSONObject, resource: JSONObject): AndroidCapabilityNetworkAuthority.Evidence {
        val authorities = request.getJSONArray("resolutionAuthorityBindings")
        val resources = request.getJSONArray("resolutionResources")
        val tokens = request.getJSONArray("resolutionTokens")
        if (authorities.length() != 1 || resources.length() != 1 || tokens.length() != 1) {
            throw ProviderFailure("provider.protocol_error")
        }
        val evidence = networkPreflights.remove(request.getString("requestId"))
            ?: throw ProviderFailure("resource.stale")
        val token = tokens.getJSONObject(0)
        val resolved = resources.getJSONObject(0)
        val digest = resource.getString("semanticResourceDigest")
        if (
            token.getLong("generation") != generation ||
            token.getString("parentRequestId") != request.getString("requestId") ||
            token.getString("requestedSemanticDigest") != digest ||
            token.getString("resolvedSemanticDigest") != digest ||
            token.getString("resolvedSemanticDigest") != resolved.getString("semanticResourceDigest") ||
            token.getLong("expiresAtMonotonicMs") != evidence.expiresAtMonotonicMs ||
            token.getString("evidenceDigest") != networkEvidenceDigest(evidence)
        ) throw ProviderFailure("resource.invalid")
        return evidence
    }

    private fun networkEvidence(evidence: AndroidCapabilityNetworkAuthority.Evidence) = JSONObject()
        .put("addresses", org.json.JSONArray(evidence.addresses))
        .put("expiresAtMonotonicMs", evidence.expiresAtMonotonicMs)
        .put("kind", "networkAddress")
        .put("resolverGeneration", generation)

    private fun networkEvidenceDigest(evidence: AndroidCapabilityNetworkAuthority.Evidence): String {
        val value = org.json.JSONArray()
            .put("resolutionEvidence")
            .put(networkEvidence(evidence))
            .toString()
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { byte -> "%02x".format(byte) }
    }

    private class NetworkCapabilityResource(
        private val authority: AndroidCapabilityNetworkAuthority,
        private val bindingId: String,
    ) : AndroidCapabilityResource {
        override fun close() = authority.release(bindingId)
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
            "brokerMonotonicMs",
            "generation",
            "inheritedBindingId",
            "invocationBinding",
            "invocationMode",
            "member",
            "module",
            "operation",
            "providerData",
            "providerPhase",
            "providerModule",
            "requestId",
            "resource",
            "resolutionAuthorityBindings",
            "resolutionIndex",
            "resolutionResources",
            "resolutionTokens",
            "source",
        )
        val required = allowed - setOf(
            "brokerMonotonicMs",
            "inheritedBindingId",
            "providerData",
            "providerPhase",
            "resolutionAuthorityBindings",
            "resolutionIndex",
            "resolutionResources",
            "resolutionTokens",
            "source",
        )
        require(keys().asSequence().all(allowed::contains) && required.all(::has))
    }

    private companion object {
        private const val TAG = "HolonomyCapabilityHost"
    }
}
