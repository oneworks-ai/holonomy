package ai.oneworks.holonomy.capability

import android.util.Base64
import java.nio.charset.Charset
import java.security.MessageDigest
import org.json.JSONObject

internal fun decodeFilesystemData(value: Any): ByteArray = when (value) {
    is String -> value.toByteArray(Charsets.UTF_8)
    is JSONObject -> {
        value.requireOnlyKeys("base64", "byteLength", "sha256")
        val bytes = Base64.decode(value.getString("base64"), Base64.DEFAULT)
        if (bytes.size != value.getInt("byteLength") || sha256(bytes) != value.getString("sha256")) {
            throw ProviderFailure("argument.invalid")
        }
        bytes
    }
    else -> throw ProviderFailure("argument.invalid")
}

internal fun encodeFilesystemData(bytes: ByteArray, encoding: Any?): Any = when (encoding) {
    null, JSONObject.NULL -> JSONObject()
        .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        .put("byteLength", bytes.size)
        .put("sha256", sha256(bytes))
    "utf8", "utf-8" -> bytes.toString(Charsets.UTF_8)
    "base64" -> Base64.encodeToString(bytes, Base64.NO_WRAP)
    "hex" -> bytes.joinToString(separator = "") { byte -> "%02x".format(byte) }
    else -> throw ProviderFailure("argument.invalid")
}

internal fun filesystemEncoding(options: JSONObject?): Any? =
    if (options == null || !options.has("encoding")) null else options.get("encoding")

internal fun filesystemCharset(options: JSONObject?): Charset {
    val encoding = filesystemEncoding(options)
    if (encoding == null || encoding === JSONObject.NULL || encoding == "utf8" || encoding == "utf-8") {
        return Charsets.UTF_8
    }
    throw ProviderFailure("argument.invalid")
}

private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString(separator = "") { byte -> "%02x".format(byte) }
