package ai.oneworks.mobile.runtime.v8

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RuntimeEngineFactoryTest {
    @Test
    fun `maps every packaged Android ABI to Node architecture identity`() {
        assertEquals("arm64", resolveRuntimeArchitecture(arrayOf("arm64-v8a")))
        assertEquals("x64", resolveRuntimeArchitecture(arrayOf("x86_64")))
    }

    @Test
    fun `rejects an architecture outside the packaged ABI boundary`() {
        assertThrows(IllegalArgumentException::class.java) {
            resolveRuntimeArchitecture(arrayOf("armeabi-v7a"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            resolveRuntimeArchitecture(emptyArray())
        }
    }
}
