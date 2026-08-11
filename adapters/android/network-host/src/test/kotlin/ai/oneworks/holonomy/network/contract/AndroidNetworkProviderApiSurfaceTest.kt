package ai.oneworks.holonomy.network

import java.lang.reflect.Modifier
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNetworkProviderApiSurfaceTest {
    @Test
    fun `javap surface does not expose partial transport injection to Java consumers`() {
        val hostSurface = javap(AndroidHttpNetworkHost::class.java.name)
        val publicConstructors = hostSurface.lineSequence()
            .map(String::trim)
            .filter { it.startsWith("public ") && it.contains("AndroidHttpNetworkHost(") }
            .toList()
        val seamNames = listOf(
            "NetworkHostDependencies",
            "NetworkClock",
            "NetworkAddressResolver",
            "NetworkResolution",
            "NetworkConnectionFactory",
            "NetworkSocketFactory",
            "NetworkTlsLayer",
            "NetworkWorker",
            "ExecutorNetworkWorker",
        )

        assertEquals(1, publicConstructors.size)
        assertTrue(publicConstructors.single().contains("(ai.oneworks.holonomy.network.AndroidNetworkHostConfiguration)"))
        assertTrue(publicConstructors.none { constructor -> seamNames.any(constructor::contains) })
        assertTrue(
            hostSurface.lineSequence().any { line ->
                line.trim().startsWith("private ") && line.contains("NetworkHostDependencies")
            },
        )
        for (className in seamNames) {
            val type = Class.forName("ai.oneworks.holonomy.network.$className")
            assertFalse("$className became public bytecode", Modifier.isPublic(type.modifiers))
            val declaration = javap(type.name).lineSequence().first { it.contains(".$className") }
            assertFalse("$className javap declaration became public", declaration.trim().startsWith("public "))
        }

        val reflectedPublicConstructors = AndroidHttpNetworkHost::class.java.constructors
        assertEquals(1, reflectedPublicConstructors.size)
        assertTrue(
            reflectedPublicConstructors.single().parameterTypes.contentEquals(
                arrayOf(AndroidNetworkHostConfiguration::class.java),
            ),
        )

        val dispatcher = AndroidHttpNetworkHost::class.java.declaredClasses.single {
            it.simpleName == "ObservationDispatcher"
        }
        assertTrue(Modifier.isPrivate(dispatcher.modifiers))
        assertThrows(ClassNotFoundException::class.java) {
            Class.forName("ai.oneworks.holonomy.network.AndroidNetworkObservationDispatcher")
        }

        assertTrue(Modifier.isPublic(AndroidNetworkObservation::class.java.modifiers))
        assertEquals(1, AndroidNetworkObservation::class.java.declaredConstructors.size)
        assertFalse(
            "AndroidNetworkObservation constructor became public",
            Modifier.isPublic(AndroidNetworkObservation::class.java.declaredConstructors.single().modifiers),
        )
        val observationSurface = javap(AndroidNetworkObservation::class.java.name)
        val observationConstructor = observationSurface.lineSequence().single {
            it.contains("AndroidNetworkObservation(")
        }
        assertFalse(observationConstructor.trim().startsWith("public "))
    }

    private fun javap(className: String): String {
        val executable = Path.of(System.getProperty("java.home"), "bin", "javap").toString()
        val process = ProcessBuilder(
            executable,
            "-classpath",
            System.getProperty("java.class.path"),
            "-p",
            className,
        ).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().use { it.readText() }
        assertTrue("javap timed out for $className", process.waitFor(5, TimeUnit.SECONDS))
        assertTrue("javap failed for $className:\n$output", process.exitValue() == 0)
        return output
    }
}
