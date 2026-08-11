package ai.oneworks.holonomy.network

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNetworkObserverLifecycleTest {
    @Test
    fun `throwing observer cannot change request results`() {
        val callbackEntered = CountDownLatch(1)
        val harness = NetworkHostHarness(
            observation = AndroidNetworkObservationConfiguration(
                observer = AndroidNetworkObserver {
                    callbackEntered.countDown()
                    throw IllegalStateException("observer failure")
                },
            ),
        )

        val resource = harness.openResource()
        assertEquals("result", harness.resourceCall("open", resource, NetworkV1.OPEN_BODY).single().type())
        val response = harness.resourceCall("finish", resource, NetworkV1.FINISH_BODY).single()

        assertEquals("result", response.type())
        assertEquals(200, (response.networkValue().get("status") as Number).toInt())
        assertTrue(callbackEntered.await(1, TimeUnit.SECONDS))
        harness.host.close()
    }

    @Test
    fun `connection quota rejection has one redacted failed terminal`() {
        val resolver = ControlledResolver()
        val observations = CopyOnWriteArrayList<AndroidNetworkObservation>()
        val quotaTerminal = CountDownLatch(1)
        val harness = NetworkHostHarness(
            addressResolver = resolver,
            limits = AndroidNetworkLimits(maxChunkBytes = 4, maxConcurrentConnections = 1),
            observation = AndroidNetworkObservationConfiguration(
                observer = AndroidNetworkObserver { observation ->
                    observations += observation
                    if (observation.errorCode == "limit_exceeded") quotaTerminal.countDown()
                },
            ),
        )
        val first = harness.dispatch(
            id = "first",
            request = requestJson("first", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:first"),
        )
        assertTrue(first.isEmpty())

        val rejected = harness.dispatch(
            id = "second",
            request = requestJson("second", NetworkV1.REQUEST, requestArgs()),
            context = contextJson("call:second"),
        )

        assertEquals("limit_exceeded", rejected.single().errorCode())
        assertTrue(quotaTerminal.await(1, TimeUnit.SECONDS))
        val terminal = observations.single { it.errorCode == "limit_exceeded" }
        assertEquals(AndroidNetworkObservationKind.TERMINAL, terminal.kind)
        assertEquals(AndroidNetworkTerminalState.FAILED, terminal.terminalState)
        assertEquals(2L, terminal.exchangeSequence)
        harness.host.close()
    }

    @Test
    fun `completion is terminal once and repeated dispose cannot duplicate it`() {
        val observations = CopyOnWriteArrayList<AndroidNetworkObservation>()
        val completion = CountDownLatch(1)
        val harness = NetworkHostHarness(
            observation = AndroidNetworkObservationConfiguration(
                observer = AndroidNetworkObserver { observation ->
                    observations += observation
                    if (observation.terminalState == AndroidNetworkTerminalState.COMPLETED) completion.countDown()
                },
            ),
        )
        val completed = harness.openResource()
        harness.resourceCall("open-completed", completed, NetworkV1.OPEN_BODY)
        harness.resourceCall("finish-completed", completed, NetworkV1.FINISH_BODY)
        assertTrue(completion.await(1, TimeUnit.SECONDS))
        harness.host.closeResource(completed.ownerCallToken, completed.providerToken, "done")

        harness.openResource()
        harness.host.close()
        harness.host.close()

        val terminalObservations = observations.filter { it.kind == AndroidNetworkObservationKind.TERMINAL }
        assertEquals(1, terminalObservations.count { it.terminalState == AndroidNetworkTerminalState.COMPLETED })
        assertTrue(terminalObservations.count { it.terminalState == AndroidNetworkTerminalState.DISPOSED } <= 1)
        assertEquals(terminalObservations.size, terminalObservations.map { it.exchangeSequence }.distinct().size)
    }
}
