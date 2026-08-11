package ai.oneworks.holonomy.network

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNetworkObserverSecurityTest {
    @Test
    fun `observer receives only bounded redacted immutable summaries`() {
        val observations = CopyOnWriteArrayList<AndroidNetworkObservation>()
        val delivered = CountDownLatch(4)
        val generation = AndroidNetworkProviderGeneration("runtime-observed", 3)
        val harness = NetworkHostHarness(
            connection = FakeNetworkConnection(
                headers = listOf("set-cookie" to "response-secret"),
                responseStatus = 201,
            ),
            generation = generation,
            observation = AndroidNetworkObservationConfiguration(
                observer = AndroidNetworkObserver { summary ->
                    observations += summary
                    delivered.countDown()
                },
            ),
        )
        val secretArgs = "{" +
            "\"headers\":[[\"authorization\",\"Bearer request-secret\"]]," +
            "\"method\":\"GET\"," +
            "\"url\":\"http://example.test/private-path?token=query-secret\"}"
        val opened = harness.dispatch(
            id = "request-id-secret",
            request = requestJson("request-id-secret", NetworkV1.REQUEST, secretArgs),
            context = contextJson("call:request-id-secret"),
        )
        val providerToken = ((JSONObject(opened.single().eventJson).get("resources") as JSONArray)
            .get(0) as JSONObject).get("providerToken") as String
        val resource = ResourceFixture("call:request-id-secret", providerToken)

        harness.resourceCall("open", resource, NetworkV1.OPEN_BODY)
        harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY)

        assertTrue(delivered.await(1, TimeUnit.SECONDS))
        assertEquals(
            listOf(
                AndroidNetworkObservationKind.REQUEST,
                AndroidNetworkObservationKind.TRANSPORT,
                AndroidNetworkObservationKind.RESPONSE,
                AndroidNetworkObservationKind.TERMINAL,
            ),
            observations.map { it.kind },
        )
        assertTrue(observations.all { it.generation == generation })
        assertTrue(observations.all { it.origin == "http://example.test:80" && it.method == "GET" })
        assertTrue(observations.all { it.elapsedMs >= 0 })
        assertEquals(201, observations.first { it.kind == AndroidNetworkObservationKind.RESPONSE }.statusCode)
        val rendered = observations.joinToString()
        for (secret in listOf(
            "private-path",
            "query-secret",
            "authorization",
            "request-secret",
            "set-cookie",
            "response-secret",
            "request-id-secret",
            providerToken,
            "8.8.8.8",
        )) {
            assertFalse("observer leaked $secret", rendered.contains(secret))
        }
        harness.host.close()
    }

    @Test
    fun `slow observer is isolated behind a bounded nonblocking queue`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val callbackExited = CountDownLatch(1)
        val received = CopyOnWriteArrayList<AndroidNetworkObservation>()
        val harness = NetworkHostHarness(
            allowedOrigins = setOf(
                "http://example.test",
                "https://queued-secret.example",
                "https://after-close-secret.example",
            ),
            observation = AndroidNetworkObservationConfiguration(
                observer = AndroidNetworkObserver { observation ->
                    received += observation
                    entered.countDown()
                    try {
                        while (!release.await(1, TimeUnit.SECONDS)) Unit
                    } catch (_: InterruptedException) {
                        var released = false
                        while (!released) {
                            try {
                                release.await()
                                released = true
                            } catch (_: InterruptedException) {
                                // Keep the running callback blocked until the test releases it.
                            }
                        }
                    } finally {
                        callbackExited.countDown()
                    }
                },
                maxPendingObservations = 2,
            ),
        )
        harness.openResource()
        assertTrue(entered.await(1, TimeUnit.SECONDS))

        harness.dispatch(
            id = "queued-secret",
            request = requestJson(
                "queued-secret",
                NetworkV1.REQUEST,
                "{\"headers\":[],\"method\":\"GET\"," +
                    "\"url\":\"https://queued-secret.example/private?token=secret\"}",
            ),
            context = contextJson("call:queued-secret"),
        )
        val publishingFinished = CountDownLatch(1)
        Thread {
            repeat(100) { index ->
                val id = "overflow-$index"
                harness.dispatch(
                    id = id,
                    request = requestJson(id, NetworkV1.REQUEST, requestArgs()),
                    context = contextJson("call:$id"),
                )
            }
            publishingFinished.countDown()
        }.apply {
            isDaemon = true
            start()
        }

        assertTrue("observer back-pressured the provider", publishingFinished.await(500, TimeUnit.MILLISECONDS))
        val closeFinished = CountDownLatch(1)
        Thread {
            harness.host.close()
            closeFinished.countDown()
        }.apply {
            isDaemon = true
            start()
        }
        assertTrue("observer blocked provider teardown", closeFinished.await(500, TimeUnit.MILLISECONDS))
        harness.dispatch(
            id = "after-close-secret",
            request = requestJson(
                "after-close-secret",
                NetworkV1.REQUEST,
                "{\"headers\":[],\"method\":\"GET\"," +
                    "\"url\":\"https://after-close-secret.example/private?token=secret\"}",
            ),
            context = contextJson("call:after-close-secret"),
        )
        val observationsField = AndroidHttpNetworkHost::class.java.getDeclaredField("observations").apply {
            isAccessible = true
        }
        val dispatcher = observationsField.get(harness.host)
        val observerField = dispatcher.javaClass.getDeclaredField("observer").apply { isAccessible = true }
        assertNull((observerField.get(dispatcher) as AtomicReference<*>).get())
        release.countDown()
        assertTrue(callbackExited.await(1, TimeUnit.SECONDS))
        assertEquals(1, received.size)
        assertFalse(received.joinToString().contains("secret"))
    }
}
