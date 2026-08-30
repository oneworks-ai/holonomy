package ai.oneworks.holonomy.v86

import android.util.Base64
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

internal data class AndroidV86Executable(
    val executableId: String,
    val path: String,
    val fixedArgs: List<String>,
    val shell: Boolean,
)

internal class AndroidV86ProcessState(
    val executableId: String,
    val executableDigest: String,
    val facade: JSONObject,
    val resourceId: String,
    val childEvents: AndroidV86EventChannel,
    val stdinEvents: AndroidV86EventChannel,
    val stdoutEvents: AndroidV86EventChannel,
    val stderrEvents: AndroidV86EventChannel,
    val stdin: AndroidV86StdinQueue,
) {
    val linuxDepthByPid = ConcurrentHashMap<Int, Int>()
    @Volatile var backendProcessId: Int? = null
    @Volatile var closed = false
    @Volatile var linuxPid: Int? = null

    fun channel(bindingId: String): AndroidV86EventChannel? = when (bindingId) {
        childBindingId -> childEvents
        stdinBindingId -> stdinEvents
        stdoutBindingId -> stdoutEvents
        stderrBindingId -> stderrEvents
        else -> null
    }

    val childBindingId get() = facade.getJSONObject("binding").getString("bindingId")
    val stdinBindingId get() = facade.optJSONObject("stdin")?.getJSONObject("binding")?.getString("bindingId")
    val stdoutBindingId get() = facade.optJSONObject("stdout")?.getJSONObject("binding")?.getString("bindingId")
    val stderrBindingId get() = facade.optJSONObject("stderr")?.getJSONObject("binding")?.getString("bindingId")

    fun closeChannels() {
        childEvents.close()
        stdinEvents.close()
        stdoutEvents.close()
        stderrEvents.close()
    }
}

internal fun processError(code: String) = JSONObject()
    .put("code", code)
    .put("message", "$code: controlled child process failed")
    .put("name", "Error")
    .put("retryable", false)

internal fun processEvent(event: String, vararg tuple: Any?) = JSONObject()
    .put("event", event)
    .put("tuple", JSONArray().apply { tuple.forEach { value -> put(value ?: JSONObject.NULL) } })
    .toString()

internal fun binarySnapshot(bytes: ByteArray) = JSONObject()
    .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
    .put("byteLength", bytes.size)
    .put("sha256", sha256(bytes))

internal fun decodeProcessInput(value: Any): ByteArray = when (value) {
    is String -> value.toByteArray(Charsets.UTF_8)
    is JSONObject -> Base64.decode(value.getString("base64"), Base64.DEFAULT).also { bytes ->
        require(bytes.size == value.getInt("byteLength") && sha256(bytes) == value.getString("sha256"))
    }
    else -> throw IllegalArgumentException("Invalid process input")
}

private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { byte -> "%02x".format(byte) }
