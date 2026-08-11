package ai.oneworks.holonomy.network

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNetworkProviderFactoryTest {
    @Test
    fun `default factory creates a fresh Android provider for each generation`() {
        val factory = AndroidNetworkProviderFactory.default(configuration())

        val first = factory.create(AndroidNetworkProviderGeneration("runtime-a", 1))
        val second = factory.create(AndroidNetworkProviderGeneration("runtime-a", 2))

        assertTrue(first is AndroidHttpNetworkHost)
        assertTrue(second is AndroidHttpNetworkHost)
        assertNotSame(first, second)
        first.close()
        second.close()
    }

    @Test
    fun `replacement factory receives generation and returns the whole provider`() {
        val generations = mutableListOf<AndroidNetworkProviderGeneration>()
        val replacements = mutableListOf<RecordingHost>()
        val factory = AndroidNetworkProviderFactory.replacement { generation ->
            generations += generation
            RecordingHost().also { replacements += it }
        }

        val generation = AndroidNetworkProviderGeneration("runtime-replacement", 7)
        val created = factory.create(generation)

        assertEquals(listOf(generation), generations)
        assertSame(replacements.single(), created)
        created.close()
        assertEquals(1, replacements.single().closeCount)
    }

    @Test
    fun `replacement factory fails closed when a provider identity is reused`() {
        val reused = RecordingHost()
        val factory = AndroidNetworkProviderFactory.replacement { reused }

        assertSame(reused, factory.create(AndroidNetworkProviderGeneration("runtime-reused", 1)))
        val failure = assertThrows(IllegalStateException::class.java) {
            factory.create(AndroidNetworkProviderGeneration("runtime-reused", 2))
        }

        assertTrue(failure.message.orEmpty().contains("fresh"))
        assertEquals(0, reused.closeCount)
        reused.close()
    }

    private fun configuration() = AndroidNetworkHostConfiguration(
        principal = "factory-test",
        allowedOrigins = setOf("https://example.test"),
    )

    private class RecordingHost : RuntimeNativeHost {
        var closeCount = 0
            private set

        override fun dispatch(
            requestId: String,
            requestJson: String,
            contextJson: String,
            binary: List<RuntimeNativeBinary>,
            sink: RuntimeNativeEventSink,
            resourceSink: RuntimeNativeResourceEventSink,
        ) = Unit

        override fun close() {
            closeCount += 1
        }
    }
}
