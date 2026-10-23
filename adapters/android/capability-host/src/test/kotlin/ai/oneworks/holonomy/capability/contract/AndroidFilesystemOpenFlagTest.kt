package ai.oneworks.holonomy.capability

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidFilesystemOpenFlagTest {
    @Test
    fun `portable readonly does not demand write authority`() {
        val flag = AndroidFilesystemOpenFlag.parse(portable("read"))
        assertEquals(setOf("read"), flag.requiredRights)
        assertEquals(setOf("read"), flag.handleRights)
        assertFalse(flag.create)
    }

    @Test
    fun `read plus create demands write authority without widening handle rights`() {
        val flag = AndroidFilesystemOpenFlag.parse(portable("read", create = true))
        assertEquals(setOf("read", "write"), flag.requiredRights)
        assertEquals(setOf("read"), flag.handleRights)
    }

    @Test
    fun `write create and readwrite preserve independent effects`() {
        val flag = AndroidFilesystemOpenFlag.parse(portable("write", create = true))
        assertEquals(setOf("write"), flag.requiredRights)
        assertFalse(flag.truncate)
        assertEquals(setOf("read", "write"), AndroidFilesystemOpenFlag.parse(portable("readWrite")).handleRights)
    }

    @Test
    fun `all supported Node strings retain their exact access and effects`() {
        val strings = mapOf(
            "r" to portable("read"),
            "r+" to portable("readWrite"),
            "w" to portable("write", create = true, truncate = true),
            "w+" to portable("readWrite", create = true, truncate = true),
            "wx" to portable("write", create = true, exclusive = true, truncate = true),
            "wx+" to portable("readWrite", create = true, exclusive = true, truncate = true),
            "a" to portable("write", create = true, append = true),
            "a+" to portable("readWrite", create = true, append = true),
            "ax" to portable("write", create = true, exclusive = true, append = true),
            "ax+" to portable("readWrite", create = true, exclusive = true, append = true),
        )
        strings.forEach { (string, fields) ->
            assertEquals(string, AndroidFilesystemOpenFlag.parse(fields), AndroidFilesystemOpenFlag.parse(string))
        }
    }

    @Test
    fun `unknown strings and nonobject types fail with stable argument invalid`() {
        listOf(null, 0, true, emptyList<Any>(), "", "rw", "rs", "wa", "r++", "W", "{\"kind\":\"portable-open-v1\"}")
            .forEach(::invalid)
    }

    @Test
    fun `portable objects reject unknown and missing keys`() {
        invalid(portable("read") + ("extra" to false))
        portable("read").keys.forEach { key -> invalid(portable("read") - key) }
        invalid(portable("read") - "append" + ("extra" to false))
    }

    @Test
    fun `portable objects reject coerced types and invalid discriminators`() {
        for (key in listOf("create", "exclusive", "truncate", "append")) {
            for (value in listOf("false", "true", 0, 1, null, emptyMap<String, Any>())) {
                invalid(portable("write") + (key to value))
            }
        }
        for (value in listOf(null, 1, true, "readonly", "READ")) invalid(portable("read") + ("access" to value))
        for (value in listOf(null, 1, "portable-open-v2")) invalid(portable("read") + ("kind" to value))
    }

    @Test
    fun `exclusive requires create and readonly cannot truncate or append`() {
        invalid(portable("write", exclusive = true))
        invalid(portable("read", truncate = true))
        invalid(portable("read", append = true))
        invalid(portable("read", create = true, append = true))
        assertTrue(AndroidFilesystemOpenFlag.parse(portable("write", truncate = true, append = true)).append)
    }

    private fun invalid(value: Any?) {
        assertEquals("argument.invalid", assertThrows(ProviderFailure::class.java) {
            AndroidFilesystemOpenFlag.parse(value)
        }.code)
    }
}

internal fun portable(
    access: String,
    create: Boolean = false,
    exclusive: Boolean = false,
    truncate: Boolean = false,
    append: Boolean = false,
): Map<String, Any> = mapOf(
    "kind" to "portable-open-v1",
    "access" to access,
    "create" to create,
    "exclusive" to exclusive,
    "truncate" to truncate,
    "append" to append,
)
