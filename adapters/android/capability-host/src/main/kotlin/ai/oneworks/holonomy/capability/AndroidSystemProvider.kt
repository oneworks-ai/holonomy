package ai.oneworks.holonomy.capability

import org.json.JSONObject

internal class AndroidSystemProvider(projection: JSONObject) {
    private val fields = JSONObject(projection.toString()).getJSONObject("fields")

    fun invoke(request: JSONObject): String {
        val resource = request.getJSONObject("resource")
        require(resource.getString("kind") == "systemField")
        val field = resource.getString("field")
        requireAuthority(request, field)
        val projection = fields.optJSONObject(field) ?: throw ProviderFailure("capability.denied")
        if (projection.getString("mode") == "unavailable" || !projection.has("value")) {
            throw ProviderFailure("capability.denied")
        }
        return success(jsonValue(projection.get("value")))
    }

    private fun requireAuthority(request: JSONObject, field: String) {
        val authorized = request.getJSONArray("authorityBindings").objects().any { binding ->
            binding.getString("providerModule") == "host.system" &&
                binding.getJSONObject("constraints").getJSONArray("fields").strings().contains(field)
        }
        if (!authorized) throw ProviderFailure("capability.denied")
    }
}
