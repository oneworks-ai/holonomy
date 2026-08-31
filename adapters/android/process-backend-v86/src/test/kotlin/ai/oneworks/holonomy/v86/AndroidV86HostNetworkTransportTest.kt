package ai.oneworks.holonomy.v86

import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidV86HostNetworkTransportTest {
    @Test
    fun `socket open consumes the trusted Backend result envelope`() {
        ServerSocket().use { server ->
            server.bind(InetSocketAddress("127.0.0.1", 0))
            val diagnostics = mutableListOf<String>()
            AndroidV86HostNetworkTransport(
                allowPrivateNetwork = true,
                diagnostic = diagnostics::add,
            ).use { transport ->
                val terminal = AndroidV86NetworkTransport.success(
                    JSONObject()
                        .put("authorized", true)
                        .put(
                            "resolution",
                            JSONObject().put("addresses", JSONArray().put("127.0.0.1")),
                        ),
                )
                val opened = transport.open(
                    JSONObject()
                        .put("hostname", "loopback.test")
                        .put("port", server.localPort)
                        .put("transport", "tcp"),
                    terminal,
                    AndroidV86NetworkEventSink {},
                )
                assertTrue(diagnostics.joinToString(), opened.getBoolean("ok"))
                val handleId = opened.getJSONObject("result").getJSONObject("value").getLong("handleId")
                assertTrue(
                    transport.control(
                        JSONObject().put("handleId", handleId).put("operation", "close"),
                    ).getBoolean("ok"),
                )
            }
        }
    }

    @Test
    fun `private DNS evidence is denied unless the Host policy explicitly allows it`() {
        val loopback = InetAddress.getByName("127.0.0.1")
        val resolver = AndroidV86NetworkAddressResolver { listOf(loopback) }
        AndroidV86HostNetworkTransport(
            allowPrivateNetwork = false,
            addressResolver = resolver,
        ).use { transport ->
            assertThrows(IllegalArgumentException::class.java) {
                transport.resolve("private.test")
            }
        }
        AndroidV86HostNetworkTransport(
            allowPrivateNetwork = true,
            addressResolver = resolver,
        ).use { transport ->
            assertEquals(listOf(loopback.hostAddress), transport.resolve("private.test"))
        }
    }

    @Test
    fun `peer disconnect emits one terminal and releases the socket permit`() {
        ServerSocket().use { firstServer ->
            firstServer.bind(InetSocketAddress("127.0.0.1", 0))
            val accepted = Thread {
                firstServer.accept().use { peer -> peer.shutdownOutput() }
            }.apply { start() }
            val events = CopyOnWriteArrayList<String>()
            val closed = CountDownLatch(1)
            AndroidV86HostNetworkTransport(
                allowPrivateNetwork = true,
                maxSockets = 1,
            ).use { transport ->
                val opened = transport.open(
                    socketRequest(firstServer.localPort),
                    authorization(),
                    AndroidV86NetworkEventSink { event ->
                        events += event.getString("event")
                        if (event.getString("event") == "close") closed.countDown()
                    },
                )
                assertTrue(opened.toString(), opened.getBoolean("ok"))
                assertTrue(closed.await(1, TimeUnit.SECONDS))
                accepted.join(1_000)

                assertEquals(listOf("end", "close"), events)
                ServerSocket().use { secondServer ->
                    secondServer.bind(InetSocketAddress("127.0.0.1", 0))
                    val secondAccepted = Thread { secondServer.accept().use { } }.apply { start() }
                    val second = transport.open(
                        socketRequest(secondServer.localPort),
                        authorization(),
                        AndroidV86NetworkEventSink {},
                    )
                    assertTrue(second.toString(), second.getBoolean("ok"))
                    secondAccepted.join(1_000)
                }
            }
        }
    }

    private fun authorization() = AndroidV86NetworkTransport.success(
        JSONObject()
            .put("authorized", true)
            .put("resolution", JSONObject().put("addresses", JSONArray().put("127.0.0.1"))),
    )

    private fun socketRequest(port: Int) = JSONObject()
        .put("hostname", "loopback.test")
        .put("port", port)
        .put("transport", "tcp")
}
