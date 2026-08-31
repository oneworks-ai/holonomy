package ai.oneworks.holonomy.v86

import android.content.res.AssetManager
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/** Host-owned, digest-verified assets for the optional Android v86 Backend. */
class AndroidV86AssetStore(
    private val assets: AssetManager,
) {
    private val manifest by lazy {
        JSONObject(readRaw(MANIFEST_PATH).toString(Charsets.UTF_8)).also { source ->
            require(source.getInt("schemaVersion") == 1)
        }
    }
    private val entries by lazy {
        val values = manifest.getJSONArray("entries")
        List(values.length(), values::getJSONObject).associateBy { item -> item.getString("name") }
    }

    val available: Boolean
        get() = manifest.getBoolean("available")

    val packageBytes: Long
        get() = manifest.getLong("packageBytes")

    fun read(name: String): ByteArray {
        require(name in REQUIRED_ASSETS) { "Unknown v86 asset" }
        val entry = requireNotNull(entries[name]) { "Missing v86 asset manifest entry: $name" }
        val value = readRaw("$ROOT/$name")
        require(value.size == entry.getInt("bytes") && value.size <= MAX_ASSET_BYTES)
        require(sha256(value) == entry.getString("sha256")) { "v86 asset digest mismatch: $name" }
        return value
    }

    fun requireBackend(configuration: JSONObject, profile: JSONObject) {
        require(available) { "The Android v86 Backend assets are not packaged" }
        val artifacts = configuration.getJSONObject("artifacts")
        val expected = mapOf(
            "bios" to "seabios.bin",
            "initrd" to "agent.cpio",
            "kernel" to "kernel.bin",
            "wasm" to "v86.wasm",
        )
        expected.forEach { (key, file) ->
            val artifact = artifacts.getJSONObject(key)
            require(artifact.getString("artifactId") == file)
            require(artifact.getString("sha256") == requireNotNull(entries[file]).getString("sha256"))
        }
        requireImageBundle(profile, requireNotNull(entries["agent.cpio"]).getString("sha256"))
        require(configuration.getJSONObject("supervisor").getInt("protocolVersion") == 1)
    }

    private fun requireImageBundle(profile: JSONObject, initrdSha256: String) {
        val imageManifest = JSONObject(read("agent.manifest.json").toString(Charsets.UTF_8))
        require(imageManifest.getInt("schemaVersion") == 1)
        require(imageManifest.getString("architecture") == "linux-x86-32")
        require(SHA256.matches(imageManifest.getString("profileDigest")))
        val artifact = imageManifest.getJSONObject("artifact")
        require(artifact.getString("name") == "agent.cpio")
        require(artifact.getString("sha256") == initrdSha256)
        require(artifact.getInt("size") == requireNotNull(entries["agent.cpio"]).getInt("bytes"))
        val sbomDescriptor = imageManifest.getJSONObject("sbom")
        require(sbomDescriptor.getString("name") == "agent.spdx.json")
        val sbomBytes = read("agent.spdx.json")
        require(sbomDescriptor.getInt("size") == sbomBytes.size)
        require(sbomDescriptor.getString("sha256") == sha256(sbomBytes))
        val sbom = JSONObject(sbomBytes.toString(Charsets.UTF_8))
        require(sbom.getString("spdxVersion") == "SPDX-2.3")
        require(sbom.getJSONArray("packages").length() == imageManifest.getInt("packageCount"))
        require(
            sbom.getString("documentNamespace") ==
                "https://holonomy.dev/spdx/v86/${imageManifest.getString("profileId")}/$initrdSha256",
        )

        val allowed = imageManifest.getJSONArray("executables").objects().associateBy { item ->
            item.getString("path")
        }
        require(allowed.size == imageManifest.getJSONArray("executables").length())
        profile.getJSONArray("executables").objects().forEach { selected ->
            val executable = selected.getJSONObject("executable")
            require(executable.getString("kind") == "guestPath")
            val expected = requireNotNull(allowed[executable.getString("path")]) {
                "Executable is outside the image allowlist"
            }
            require(!selected.getBoolean("shell") || expected.getBoolean("shell"))
        }
    }

    private fun readRaw(path: String): ByteArray =
        assets.open(path, AssetManager.ACCESS_STREAMING).use { input -> input.readBytes() }

    private fun sha256(value: ByteArray) = MessageDigest.getInstance("SHA-256")
        .digest(value)
        .joinToString("") { byte -> "%02x".format(byte) }

    private companion object {
        private const val MANIFEST_PATH = "holonomy-host/process-backends/v86/backend-manifest.json"
        private const val MAX_ASSET_BYTES = 64 * 1024 * 1024
        private const val ROOT = "holonomy-host/process-backends/v86"
        private val REQUIRED_ASSETS = setOf(
            "backend-manifest.json",
            "driver-network.mjs",
            "driver-sockets.mjs",
            "driver-support.mjs",
            "driver.mjs",
            "fuse-support.mjs",
            "fuse.mjs",
            "kernel.bin",
            "libv86.mjs",
            "seabios.bin",
            "shim.mjs",
            "agent.cpio",
            "agent.manifest.json",
            "agent.spdx.json",
            "v86.wasm",
        )
        private val SHA256 = Regex("^[a-f0-9]{64}$")
    }
}

private fun JSONArray.objects(): List<JSONObject> =
    List(length()) { index -> getJSONObject(index) }
