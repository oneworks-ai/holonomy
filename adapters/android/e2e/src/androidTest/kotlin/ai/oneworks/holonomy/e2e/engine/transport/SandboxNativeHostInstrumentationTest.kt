package ai.oneworks.holonomy.e2e.engine.transport

import ai.oneworks.holonomy.e2e.createE2eRuntimeNativeHost
import ai.oneworks.holonomy.host.FailClosedRuntimeNativeHost
import ai.oneworks.holonomy.network.AndroidHttpNetworkHost
import ai.oneworks.holonomy.session.RuntimeId
import ai.oneworks.holonomy.session.SessionNativeHostContext
import ai.oneworks.holonomy.session.SessionSandboxNetworkAccess
import ai.oneworks.holonomy.session.SessionSandboxNetworkLimits
import ai.oneworks.holonomy.session.SessionSandboxNetworkPolicy
import ai.oneworks.holonomy.session.SessionSandboxPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxNativeHostInstrumentationTest {
    @Test
    fun sandboxPolicySelectsFailClosedMockOnlyAndRestrictedHostsWithExactAuthority() {
        val none = createE2eRuntimeNativeHost(context(SessionSandboxPolicy(), generation = 1))
        assertTrue(none is FailClosedRuntimeNativeHost)
        assertEquals(0, JSONObject(none.configurationJson()).getJSONArray("capabilities").length())

        val limits = SessionSandboxNetworkLimits(maxConcurrentConnections = 2, socketTimeoutMs = 1_500)
        val mockPolicy = policy(SessionSandboxNetworkAccess.MOCK_ONLY, limits)
        val mock = createE2eRuntimeNativeHost(context(mockPolicy, generation = 2))
        val mockConfiguration = JSONObject(mock.configurationJson())
        assertEquals("host.network.mock", mockConfiguration.getJSONArray("capabilities").getString(0))
        assertEquals(1, mockConfiguration.getJSONArray("capabilities").length())
        assertEquals("holonomy:314:runtime:2", mockConfiguration.getString("principal"))
        assertEquals(
            listOf("https://api.example"),
            mockConfiguration.getJSONObject("network").getJSONArray("allowedOrigins").strings(),
        )
        assertEquals("deny", mockConfiguration.getJSONObject("network").getString("privateNetwork"))
        assertEquals(
            2,
            mockConfiguration.getJSONObject("network").getJSONObject("limits").getInt("maxConcurrentConnections"),
        )
        assertFalse(mock is AndroidHttpNetworkHost)

        val restrictedPolicy = policy(SessionSandboxNetworkAccess.RESTRICTED, limits)
        val restricted = createE2eRuntimeNativeHost(context(restrictedPolicy, generation = 3))
        val restrictedConfiguration = JSONObject(restricted.configurationJson())
        assertTrue(restricted is AndroidHttpNetworkHost)
        assertEquals("host.network.http", restrictedConfiguration.getJSONArray("capabilities").getString(0))
        assertEquals("holonomy:314:runtime:3", restrictedConfiguration.getString("principal"))
        assertEquals(
            listOf("https://api.example"),
            restrictedConfiguration.getJSONObject("network").getJSONArray("allowedOrigins").strings(),
        )
        assertEquals("deny", restrictedConfiguration.getJSONObject("network").getString("privateNetwork"))

        none.close()
        mock.close()
        restricted.close()
    }

    private fun policy(
        access: SessionSandboxNetworkAccess,
        limits: SessionSandboxNetworkLimits,
    ) = SessionSandboxPolicy(
        network = SessionSandboxNetworkPolicy(
            access = access,
            allowedOrigins = setOf("https://api.example"),
            allowedSchemes = setOf("https"),
            limits = limits,
        ),
    )

    private fun context(policy: SessionSandboxPolicy, generation: Long) = SessionNativeHostContext(
        runtimeId = RuntimeId("runtime"),
        runtimeGeneration = generation,
        nativeHostGeneration = 1,
        sandboxPolicy = policy,
        sandboxPolicyDigest = policy.digest,
        principal = "holonomy:314:runtime:$generation",
    )

    private fun org.json.JSONArray.strings(): List<String> =
        (0 until length()).map(::getString)
}
