package ai.oneworks.holonomy.session

import ai.oneworks.holonomy.host.RuntimeModuleSource
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

data class SessionRuntimePluginFile(
    val url: String,
    val source: String,
    val sha256: String,
) {
    internal val sourceByteLength = strictUtf8Bytes(source).size

    init {
        requirePluginUrl(url)
        require(sourceByteLength <= SessionProtocolLimits.MAX_MODULE_BYTES)
        require(SHA256.matches(sha256) && digest(strictUtf8Bytes(source)) == sha256)
    }
}

data class SessionRuntimePluginBundle(
    val schemaVersion: Int,
    val instanceId: String,
    val rootUrl: String,
    val entryUrl: String,
    val exportName: String,
    val configJson: String,
    val bundleSha256: String,
    val files: List<SessionRuntimePluginFile>,
) {
    init {
        require(schemaVersion == 1)
        require(PLUGIN_ID.matches(instanceId) && EXPORT_NAME.matches(exportName))
        require(rootUrl == "holo-plugins:///$instanceId/" && canonicalUri(rootUrl) == rootUrl)
        require(entryUrl.startsWith(rootUrl) && canonicalUri(entryUrl) == entryUrl)
        require(SHA256.matches(bundleSha256))
        require(files.isNotEmpty() && files.size <= SessionProtocolLimits.MAX_PLUGIN_FILES)
        require(files.sumOf(SessionRuntimePluginFile::sourceByteLength) <=
            SessionProtocolLimits.MAX_PLUGIN_GRAPH_BYTES)
        require(files.map(SessionRuntimePluginFile::url).toSet().size == files.size)
        require(files.all { file -> file.url.startsWith(rootUrl) })
        require(files.any { file -> file.url == entryUrl })
        require(runCatching { JsonParser.parseString(configJson) }.getOrNull() != null)
        val actualBundleSha256 = bundleDigest(this)
        require(actualBundleSha256 == bundleSha256) {
            "Runtime plugin Bundle digest mismatch"
        }
    }
}

internal fun encodeRuntimePluginBundles(bundles: List<SessionRuntimePluginBundle>): JsonArray = JsonArray().apply {
    bundles.forEach { bundle ->
        add(JsonObject().apply {
            addProperty("schemaVersion", bundle.schemaVersion)
            addProperty("instanceId", bundle.instanceId)
            addProperty("rootUrl", bundle.rootUrl)
            addProperty("entryUrl", bundle.entryUrl)
            addProperty("exportName", bundle.exportName)
            add("config", JsonParser.parseString(bundle.configJson))
            addProperty("bundleSha256", bundle.bundleSha256)
            add("files", JsonArray().apply {
                bundle.files.forEach { file ->
                    add(JsonObject().apply {
                        addProperty("url", file.url)
                        addProperty("source", file.source)
                        addProperty("sha256", file.sha256)
                    })
                }
            })
        })
    }
}

internal fun decodeRuntimePluginBundles(value: JsonArray?): List<SessionRuntimePluginBundle> {
    if (value == null) return emptyList()
    require(value.size() <= SessionProtocolLimits.MAX_RUNTIME_PLUGINS)
    val bundles = value.map { element ->
        val input = element.asJsonObject.apply {
            requireOnlyPluginKeys(
                "schemaVersion", "instanceId", "rootUrl", "entryUrl", "exportName",
                "config", "bundleSha256", "files",
            )
        }
        SessionRuntimePluginBundle(
            schemaVersion = input.get("schemaVersion").asInt,
            instanceId = input.get("instanceId").asString,
            rootUrl = input.get("rootUrl").asString,
            entryUrl = input.get("entryUrl").asString,
            exportName = input.get("exportName").asString,
            configJson = input.get("config").toString(),
            bundleSha256 = input.get("bundleSha256").asString,
            files = input.getAsJsonArray("files").map { fileElement ->
                val file = fileElement.asJsonObject.apply { requireOnlyPluginKeys("url", "source", "sha256") }
                SessionRuntimePluginFile(
                    url = file.get("url").asString,
                    source = file.get("source").asString,
                    sha256 = file.get("sha256").asString,
                )
            },
        )
    }
    require(bundles.map(SessionRuntimePluginBundle::instanceId).toSet().size == bundles.size)
    return bundles
}

internal class SessionRuntimePluginGraph(bundles: List<SessionRuntimePluginBundle>) {
    private val modules = buildMap {
        bundles.forEach { bundle ->
            bundle.files.forEach { file ->
                val identity = pluginIdentity(file.url, bundle.bundleSha256)
                require(put(identity, PluginModule(bundle.rootUrl, file.url, RuntimeModuleSource(identity, file.source))) == null)
            }
        }
    }
    private val modulesByPublicUrl = modules.values.associateBy(PluginModule::publicUrl)
    private val manifest = RuntimeModuleSource(
        RUNTIME_PLUGIN_MANIFEST_URL,
        buildString {
            bundles.forEachIndexed { index, bundle ->
                append("import * as plugin")
                append(index)
                append(" from ")
                append(JsonObject().apply { addProperty("url", bundle.entryUrl) }.get("url"))
                append(";\n")
            }
            append("export const runtimePluginNamespaces=Object.freeze({")
            bundles.forEachIndexed { index, bundle ->
                if (index > 0) append(',')
                append(JsonObject().apply {
                    addProperty("identity", pluginIdentity(bundle.entryUrl, bundle.bundleSha256))
                }.get("identity"))
                append(":plugin")
                append(index)
            }
            append("});")
        },
    )

    fun resolve(specifier: String, referrerUrl: String?): RuntimeModuleSource? {
        if (referrerUrl == null) return null
        if (referrerUrl == RUNTIME_PLUGIN_MANIFEST_URL) return modulesByPublicUrl[specifier]?.source
        if (specifier == RUNTIME_PLUGIN_MANIFEST_URL && referrerUrl.startsWith("holonomy:")) return manifest
        if (referrerUrl.startsWith("holonomy:")) return modules[specifier]?.source
        val referrer = modules[referrerUrl] ?: return null
        val publicUrl = runCatching { resolvePluginUrl(specifier, referrer.publicUrl) }.getOrNull()
            ?: return null
        if (!publicUrl.startsWith(referrer.rootUrl)) return null
        return modules[pluginIdentity(publicUrl, pluginDigest(referrerUrl))]?.source
    }

    private data class PluginModule(
        val rootUrl: String,
        val publicUrl: String,
        val source: RuntimeModuleSource,
    )
}

private fun bundleDigest(bundle: SessionRuntimePluginBundle): String = digest(
    bundleCanonical(bundle).toByteArray(Charsets.UTF_8),
)

private fun bundleCanonical(bundle: SessionRuntimePluginBundle): String = canonicalJson(
        JsonObject().apply {
            add("config", JsonParser.parseString(bundle.configJson))
            addProperty("entryUrl", bundle.entryUrl)
            addProperty("exportName", bundle.exportName)
            add("files", JsonArray().apply {
                bundle.files.forEach { file ->
                    add(JsonObject().apply {
                        addProperty("sha256", file.sha256)
                        addProperty("url", file.url)
                    })
                }
            })
            addProperty("instanceId", bundle.instanceId)
            addProperty("rootUrl", bundle.rootUrl)
            addProperty("schemaVersion", 1)
        },
)

private fun canonicalJson(value: JsonElement): String = when {
    value.isJsonNull -> "null"
    value.isJsonArray -> value.asJsonArray.joinToString(separator = ",", prefix = "[", postfix = "]") {
        canonicalJson(it)
    }
    value.isJsonObject -> value.asJsonObject.entrySet().sortedBy(Map.Entry<String, JsonElement>::key)
        .joinToString(separator = ",", prefix = "{", postfix = "}") { (key, item) ->
            JsonObject().apply { addProperty("key", key) }.get("key").toString() + ":" + canonicalJson(item)
        }
    else -> value.toString()
}

private fun pluginIdentity(url: String, bundleSha256: String): String = "$url?holo-bundle=$bundleSha256"

private fun pluginDigest(identity: String): String = URI(identity).rawQuery
    ?.removePrefix("holo-bundle=")
    ?.takeIf(SHA256::matches)
    ?: throw IllegalArgumentException("Invalid Runtime plugin identity")

private fun canonicalUri(value: String): String {
    val uri = URI(value)
    require(uri.scheme == "holo-plugins" && uri.rawAuthority == null)
    require(uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.startsWith('/'))
    require(uri.rawPath.split('/').none { segment -> segment == "." || segment == ".." })
    return "${uri.scheme}://${uri.rawPath}"
}

private fun resolvePluginUrl(specifier: String, referrerUrl: String): String {
    val candidate = URI(specifier)
    if (candidate.isAbsolute) return canonicalUri(specifier)
    require(candidate.rawQuery == null && candidate.rawFragment == null)
    val referrer = URI(referrerUrl)
    val resolvedPath = URI(referrer.rawPath).resolve(candidate).normalize().rawPath
    return canonicalUri("holo-plugins://$resolvedPath")
}

private fun requirePluginUrl(value: String) {
    require(value.toByteArray(Charsets.UTF_8).size <= SessionProtocolLimits.MAX_URL_BYTES)
    val uri = URI(value)
    require(uri.scheme == "holo-plugins" && uri.host == null && uri.query == null && uri.fragment == null)
    require(uri.normalize().toString() == value)
}

private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString("") { byte -> "%02x".format(byte) }

private fun strictUtf8Bytes(value: String): ByteArray {
    val encoded = try {
        Charsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(value))
    } catch (error: CharacterCodingException) {
        throw IllegalArgumentException("Runtime plugin source must be Unicode scalar text", error)
    }
    return ByteArray(encoded.remaining()).also(encoded::get)
}

private fun JsonObject.requireOnlyPluginKeys(vararg allowed: String) {
    val expected = allowed.toSet()
    require(entrySet().all { (name, _) -> name in expected } && expected.all(::has))
}

private val PLUGIN_ID = Regex("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
private val EXPORT_NAME = Regex("[A-Za-z_\\$][A-Za-z0-9_\\$]*")
private val SHA256 = Regex("[0-9a-f]{64}")
internal const val RUNTIME_PLUGIN_MANIFEST_URL = "holo-plugins:///manifest.mjs"
