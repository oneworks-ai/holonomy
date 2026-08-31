package ai.oneworks.holonomy.capability

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

internal data class AndroidFilesystemResolutionRequest(
    val operation: String,
    val segments: List<String>,
    val snapshot: AndroidFilesystemResolutionSnapshot,
    val symlinks: String,
)

internal data class AndroidFilesystemResolutionSnapshot(
    val evidence: JSONObject,
    val resolvedVirtualUrl: String,
    val target: File,
)

internal class AndroidFilesystemResolution(private val workspace: File) {
    fun request(segments: List<String>, operation: String, symlinks: String) =
        AndroidFilesystemResolutionRequest(operation, segments, snapshot(segments, operation, symlinks), symlinks)

    fun verify(request: AndroidFilesystemResolutionRequest) =
        snapshot(request.segments, request.operation, request.symlinks)

    fun evidenceDigest(evidence: JSONObject): String = sha256(
        canonicalJson(JSONArray().put("resolutionEvidence").put(evidence)),
    )

    private fun snapshot(segments: List<String>, operation: String, symlinks: String): AndroidFilesystemResolutionSnapshot {
        if (segments.isEmpty() || segments.size > 255 || segments.any { !validSegment(it) }) {
            throw ProviderFailure("resource.invalid")
        }
        val lexical = segments.fold(workspace) { current, segment -> File(current, segment) }
        val chain = identityChain(segments, symlinks)
        val finalLink = Files.isSymbolicLink(lexical.toPath())
        val target = if (operation == "filesystem.metadata.lstat" && finalLink) {
            requireParent(lexical).canonicalFile.resolve(lexical.name)
        } else {
            lexical.canonicalFile
        }
        requireInside(target)
        if (finalLink && symlinks == "withinRoot") requireInside(lexical.canonicalFile)
        val attributes = attributes(target)
        val targetParent = requireParent(target)
        val parent = attributes(targetParent)
        val targetIdentity = attributes?.let { identity(target, it) }
            ?: sha256("filesystemMissingTarget\u0000${parent?.let { identity(targetParent, it) } ?: "missing"}\u0000${target.name}")
        val targetType = when {
            attributes == null -> "missing"
            attributes.isSymbolicLink -> "symlink"
            attributes.isDirectory -> "directory"
            else -> "file"
        }
        val relative = workspace.toPath().relativize(target.toPath()).map { it.toString() }
        return AndroidFilesystemResolutionSnapshot(
            evidence = JSONObject()
                .put("ancestorIdentityDigests", JSONArray(chain))
                .put("kind", "filesystemTarget")
                .put("rootId", WORKSPACE_ROOT_ID)
                .put("targetIdentityDigest", targetIdentity)
                .put("targetType", targetType),
            resolvedVirtualUrl = "holo-fs://$WORKSPACE_ROOT_ID/${relative.joinToString("/")}",
            target = target,
        )
    }

    private fun identityChain(segments: List<String>, symlinks: String): List<String> {
        val output = mutableListOf<String>()
        var current = workspace
        attributes(current)?.let { output += identity(current, it) }
        for (segment in segments) {
            current = File(current, segment)
            val attributes = attributes(current) ?: break
            if (attributes.isSymbolicLink && symlinks == "deny") throw ProviderFailure("resource.cross_root")
            output += identity(current, attributes)
        }
        if (output.size > 256) throw ProviderFailure("resource.invalid")
        return output
    }

    private fun identity(file: File, value: BasicFileAttributes) = sha256(
        listOf(
            "filesystemIdentity",
            file.absolutePath,
            value.fileKey()?.toString() ?: "none",
            value.size().toString(),
            value.lastModifiedTime().toMillis().toString(),
            value.creationTime().toMillis().toString(),
            value.isDirectory.toString(),
            value.isRegularFile.toString(),
            value.isSymbolicLink.toString(),
        ).joinToString("\u0000"),
    )

    private fun attributes(file: File): BasicFileAttributes? = try {
        Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (_: NoSuchFileException) {
        null
    }

    private fun requireInside(file: File) {
        if (file != workspace && !file.path.startsWith("${workspace.path}${File.separator}")) {
            throw ProviderFailure("resource.cross_root")
        }
    }

    private fun requireParent(file: File): File = file.parentFile ?: throw ProviderFailure("resource.invalid")

    private fun validSegment(value: String) = value.isNotEmpty() && value != "." && value != ".." &&
        !value.contains('/') && !value.contains('\\') && !value.contains('\u0000')

    private fun canonicalJson(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is Boolean, is Number -> value.toString()
        is String -> JSONObject.quote(value)
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonicalJson(value.get(it)) }
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { key ->
            "${JSONObject.quote(key)}:${canonicalJson(value.get(key))}"
        }
        else -> throw ProviderFailure("provider.protocol_error")
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private companion object {
        private const val WORKSPACE_ROOT_ID = "workspace"
    }
}
