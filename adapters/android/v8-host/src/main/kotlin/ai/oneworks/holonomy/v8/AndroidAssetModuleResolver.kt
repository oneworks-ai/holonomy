package ai.oneworks.holonomy.v8

import android.content.res.AssetManager
import ai.oneworks.holonomy.host.RuntimeEngineErrorCode
import ai.oneworks.holonomy.host.RuntimeEngineException
import ai.oneworks.holonomy.host.RuntimeModuleSource
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.json.JSONObject

internal class AndroidAssetModuleResolver(
    private val assets: AssetManager,
) {
    private val manifestAssets: Map<String, ManifestAsset> = loadAndVerifyManifest()

    fun resolve(specifier: String, referrerUrl: String?): RuntimeModuleSource {
        val resourceUrl = canonicalize(specifier, referrerUrl)
        val assetPath = resourceUrl.toAssetPath()
        val manifestAsset = manifestAssets[assetPath]
        if (manifestAsset == null || manifestAsset.kind !in MODULE_ASSET_KINDS) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_NOT_FOUND,
                "The requested runtime module was not found",
            )
        }
        val source = try {
            readUtf8Asset(assetPath)
        } catch (_: Throwable) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_NOT_FOUND,
                "The requested runtime module was not found",
            )
        }
        if (source.isBlank()) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The resolved runtime module was empty",
            )
        }
        return RuntimeModuleSource(resourceUrl.toString(), source)
    }

    fun readGuestAssetJson(path: String): String? {
        val manifestAsset = manifestAssets[path]
        if (manifestAsset?.guestReadable != true) return null
        val bytes = try {
            readBoundedAsset(path)
        } catch (_: Throwable) {
            return null
        }
        if (sha256(bytes) != manifestAsset.sha256) return null
        val source = runCatching { decodeUtf8(bytes) }.getOrNull() ?: return null
        return JSONObject()
            .put("sha256", manifestAsset.sha256)
            .put("source", source)
            .toString()
    }

    private fun loadAndVerifyManifest(): Map<String, ManifestAsset> {
        try {
            val manifest = JSONObject(decodeUtf8(readBoundedAsset(MANIFEST_ASSET_PATH)))
            if (manifest.getInt("schemaVersion") != MANIFEST_SCHEMA_VERSION) throw IllegalArgumentException()
            val sources = manifest.getJSONArray("typescriptSources")
            if (sources.length() == 0) throw IllegalArgumentException()
            val sourcePaths = mutableSetOf<String>()
            for (index in 0 until sources.length()) {
                val source = sources.getJSONObject(index)
                val path = source.getString("path")
                if (!path.startsWith("src/") || !sourcePaths.add(path)) throw IllegalArgumentException()
                requireDigest(source.getString("sha256"))
            }

            val entries = manifest.getJSONArray("assets")
            val output = linkedMapOf<String, ManifestAsset>()
            for (index in 0 until entries.length()) {
                val entry = entries.getJSONObject(index)
                val path = entry.getString("path")
                if (!path.isSafeAssetPath() || !path.startsWith("runtime/") || path == MANIFEST_ASSET_PATH) {
                    throw IllegalArgumentException()
                }
                val item = ManifestAsset(
                    guestReadable = entry.optBoolean("guestReadable", false),
                    kind = entry.getString("kind"),
                    sha256 = requireDigest(entry.getString("sha256")),
                )
                if (output.put(path, item) != null) throw IllegalArgumentException()
            }
            val actual = listAssetFiles("runtime").toSet()
            val expected = output.keys + MANIFEST_ASSET_PATH
            if (actual != expected) throw IllegalArgumentException()
            for ((path, item) in output) {
                if (sha256(readBoundedAsset(path)) != item.sha256) throw IllegalArgumentException()
                if (item.guestReadable && item.kind != "fixture") throw IllegalArgumentException()
            }
            return output.toMap()
        } catch (error: RuntimeEngineException) {
            throw error
        } catch (_: Throwable) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The packaged runtime asset manifest is invalid",
            )
        }
    }

    private fun listAssetFiles(root: String): List<String> {
        val children = assets.list(root).orEmpty()
        if (children.isEmpty()) return listOf(root)
        return children.flatMap { child -> listAssetFiles("$root/$child") }
    }

    private fun requireDigest(value: String): String {
        if (!SHA256_PATTERN.matches(value)) throw IllegalArgumentException()
        return value
    }

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun canonicalize(specifier: String, referrerUrl: String?): URI {
        val resolved = try {
            when {
                specifier == "acorn" -> URI(ACORN_RESOURCE_URL)
                specifier == "cordis" -> URI(CORDIS_RESOURCE_URL)
                specifier == "cosmokit" -> URI(COSMOKIT_RESOURCE_URL)
                URI(specifier).isAbsolute -> URI(specifier)
                referrerUrl != null -> URI(referrerUrl).resolve(specifier)
                else -> throw IllegalArgumentException("missing referrer")
            }.normalize()
        } catch (_: Throwable) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The runtime module specifier was invalid",
            )
        }
        if (resolved.scheme != INTERNAL_SCHEME || resolved.host != null || resolved.query != null || resolved.fragment != null) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The runtime module resolved outside packaged assets",
            )
        }
        resolved.toAssetPath()
        return resolved
    }

    private fun URI.toAssetPath(): String {
        val path = path?.removePrefix("/") ?: ""
        if (!path.isSafeAssetPath() || !path.startsWith("runtime/")) {
            throw RuntimeEngineException(
                RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                "The runtime module resolved outside packaged assets",
            )
        }
        return path
    }

    private fun String.isSafeAssetPath(): Boolean =
        isNotEmpty() &&
            !startsWith('/') &&
            !contains('\\') &&
            split('/').none { segment -> segment.isEmpty() || segment == "." || segment == ".." }

    private fun readUtf8Asset(path: String): String {
        val bytes = readBoundedAsset(path)
        return decodeUtf8(bytes)
    }

    private fun decodeUtf8(bytes: ByteArray): String = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()

    private fun readBoundedAsset(path: String): ByteArray =
        assets.open(path, AssetManager.ACCESS_STREAMING).use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(BUFFER_BYTES)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > MAX_MODULE_BYTES) {
                    throw RuntimeEngineException(
                        RuntimeEngineErrorCode.MODULE_RESOLUTION_FAILED,
                        "The runtime module exceeds the Android host limit",
                    )
                }
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }

    private companion object {
        private const val INTERNAL_SCHEME = "holonomy"
        private const val ACORN_RESOURCE_URL = "holonomy:///runtime/vendor/acorn.mjs"
        private const val CORDIS_RESOURCE_URL = "holonomy:///runtime/vendor/cordis.mjs"
        private const val COSMOKIT_RESOURCE_URL = "holonomy:///runtime/vendor/cosmokit.mjs"
        private const val BUFFER_BYTES = 8 * 1024
        private const val MANIFEST_ASSET_PATH = "runtime/asset-manifest.json"
        private const val MANIFEST_SCHEMA_VERSION = 2
        private const val MAX_MODULE_BYTES = 2 * 1024 * 1024
        private val MODULE_ASSET_KINDS = setOf("bootstrap", "runtime-output", "vendor")
        private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    }

    private data class ManifestAsset(
        val guestReadable: Boolean,
        val kind: String,
        val sha256: String,
    )
}
