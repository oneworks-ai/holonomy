package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidHttpNetworkHostContractTest {
    @Test
    fun `performs bounded upload and credit driven response streaming`() {
        val connection = FakeNetworkConnection(
            body = "abcdef".toByteArray(),
            headers = listOf("content-type" to "text/plain"),
        )
        val harness = NetworkHostHarness(connection = connection)
        val resource = harness.openResource()

        assertEquals("result", harness.resourceCall("open", resource, NetworkV1.OPEN_BODY).single().type())
        assertEquals(
            "result",
            harness.resourceCall(
                "write",
                resource,
                NetworkV1.WRITE_BODY,
                listOf(RuntimeNativeBinary("body:0", "ping".toByteArray())),
            ).single().type(),
        )
        val finish = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY).single()
        assertEquals(true, finish.networkValue().get("hasBody"))
        assertEquals(200, (finish.networkValue().get("status") as Number).toInt())
        assertEquals("ping", connection.uploaded.toString(Charsets.UTF_8.name()))

        val bodyEvents = harness.resourceCall("read", resource, NetworkV1.READ_BODY, mode = "stream")
        assertTrue(bodyEvents.isEmpty())
        harness.host.grantCredits("call:read", 1)
        assertEquals("abcd", bodyEvents.single().binary.single().data.toString(Charsets.UTF_8))
        harness.host.grantCredits("call:read", 1)
        assertEquals("ef", bodyEvents[1].binary.single().data.toString(Charsets.UTF_8))
        harness.host.grantCredits("call:read", 1)
        assertEquals(listOf("chunk", "chunk", "end"), bodyEvents.map { it.type() })

        harness.host.closeResource("call:request", resource.providerToken, "done")
        assertEquals(1, connection.disconnects)
        harness.host.close()
    }

    @Test
    fun `rejects strict schema authority and opaque resource mismatches`() {
        val harness = NetworkHostHarness()
        val malformed = harness.dispatch(
            id = "bad",
            request = requestJson("bad", NetworkV1.REQUEST, requestArgs(), extra = "\"extra\":true,"),
            context = contextJson("call:bad"),
        )
        assertEquals("invalid_request", malformed.single().errorCode())

        val denied = harness.dispatch(
            id = "authority",
            request = requestJson("authority", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:authority", principal = "other"),
        )
        assertEquals("capability_unsupported", denied.single().errorCode())

        val resource = harness.openResource()
        val mismatched = harness.resourceCall(
            "mismatch",
            resource.copy(ownerCallToken = "call:someone-else"),
            NetworkV1.OPEN_BODY,
        )
        assertEquals("resource_invalid", mismatched.single().errorCode())
        harness.host.close()
    }

    @Test
    fun `connection uses the single admitted DNS snapshot`() {
        var attempts = 0
        val resolver = ImmediateResolver {
            attempts += 1
            if (attempts == 1) {
                listOf(InetAddress.getByName("8.8.8.8"))
            } else {
                listOf(InetAddress.getByName("127.0.0.1"))
            }
        }
        val harness = NetworkHostHarness(addressResolver = resolver, privateNetwork = PrivateNetworkPolicy.DENY)
        val resource = harness.openResource()
        harness.resourceCall("open", resource, NetworkV1.OPEN_BODY)
        val finish = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY)

        assertEquals("result", finish.single().type())
        assertEquals(1, attempts)
        assertEquals(1, harness.connectionCreates)
        assertTrue(harness.connectionTargets.single().address.contentEquals(InetAddress.getByName("8.8.8.8").address))
        harness.host.close()
    }

    @Test
    fun `capability binding supplies the exact admitted address without ambient DNS`() {
        var now = 1_000L
        var capabilityLookups = 0
        val configuration = AndroidNetworkHostConfiguration(
            principal = "test-principal",
            allowedOrigins = setOf("http://example.test"),
            privateNetwork = PrivateNetworkPolicy.DENY,
            limits = AndroidNetworkLimits(maxChunkBytes = 4),
        )
        val authority = AndroidCapabilityNetworkAuthority(
            configuration = configuration,
            generation = 7,
            clock = { now },
            lookup = {
                capabilityLookups += 1
                listOf(InetAddress.getByName("8.8.4.4"))
            },
        )
        val evidence = authority.preflight("http://example.test", 250.0)
        authority.bind("binding-1", evidence)
        val harness = NetworkHostHarness(
            addressResolver = ImmediateResolver { error("ambient DNS must not run") },
            capabilityAuthority = authority,
            connection = FakeNetworkConnection(),
            generation = AndroidNetworkProviderGeneration("capability-network", 7),
            privateNetwork = PrivateNetworkPolicy.DENY,
        )

        val resource = harness.openResource("binding-1")
        harness.resourceCall("open", resource, NetworkV1.OPEN_BODY)
        val finish = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY)

        assertEquals("result", finish.single().type())
        assertEquals(1, capabilityLookups)
        assertEquals(0, harness.resolveCalls)
        assertTrue(harness.connectionTargets.single().address.contentEquals(InetAddress.getByName("8.8.4.4").address))
        authority.cloneBinding("binding-1", "binding-2")
        authority.release("binding-1")
        assertTrue(runCatching { authority.resolve("binding-1", configuration.authorizeUrl("http://example.test/")) }.isFailure)
        assertEquals(
            1,
            authority.resolve("binding-2", configuration.authorizeUrl("http://example.test/")).size,
        )
        authority.release("binding-2")
        assertTrue(runCatching { authority.resolve("binding-2", configuration.authorizeUrl("http://example.test/")) }.isFailure)
        now += 30_001
        harness.host.close()
        authority.close()
    }
}
