package ai.oneworks.holonomy.capability

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

internal class AndroidFilesystemProvider(
    workspaceDirectory: File,
    private val generation: Long,
    private val resources: CapabilityResourceStore,
) {
    private val workspace = workspaceDirectory.apply {
        if (!mkdirs() && !isDirectory) throw IllegalStateException("Capability workspace is unavailable")
    }.canonicalFile
    private val resolution = AndroidFilesystemResolution(workspace)
    private val pendingResolutions = mutableMapOf<String, AndroidFilesystemResolutionPlan>()
    private val nextBinding = AtomicLong(1)
    private val nextFd = AtomicLong(10)
    private val openHandles = mutableSetOf<String>()
    private val openWatchers = mutableSetOf<String>()

    fun invoke(request: JSONObject): String {
        val resource = request.getJSONObject("resource")
        require(resource.getString("kind") == "filesystem")
        val operation = request.getString("operation")
        when (request.optString("providerPhase")) {
            "preflight" -> return preflight(request, resource, operation)
            "verify" -> return verify(request)
            "cancel" -> {
                pendingResolutions.remove(request.getString("requestId"))
                return success(JSONObject())
            }
        }
        val inherited = request.optString("inheritedBindingId").ifEmpty { null }
        if (inherited != null) return invokeResource(request, operation, inherited)
        if (request.optString("providerPhase") != "execute") throw ProviderFailure("provider.protocol_error")
        val plan = pendingResolutions.remove(request.getString("requestId"))
            ?: throw ProviderFailure("resource.stale")
        val resolved = validateExecution(request, plan)
        val target = resolved.first().target
        return when (operation) {
            "filesystem.file.read" -> readPath(request, target)
            "filesystem.file.write" -> writePath(request, target)
            "filesystem.file.open" -> open(request, resource, target)
            "filesystem.metadata.stat" -> {
                requireAuthority(request, "read")
                success(stat(target, followLinks = true))
            }
            "filesystem.metadata.lstat" -> {
                requireAuthority(request, "read")
                success(stat(target, followLinks = false))
            }
            "filesystem.directory.read" -> readdir(request, target)
            "filesystem.directory.create" -> mkdir(request, resource, target)
            "filesystem.entry.rename" -> rename(request, resource, target, resolved.getOrNull(1)?.target)
            "filesystem.entry.unlink" -> {
                requireAuthority(request, "delete")
                unlink(target)
            }
            "filesystem.watch.subscribe" -> watch(request, resource, target)
            else -> throw ProviderFailure("provider.unavailable")
        }
    }

    private fun preflight(request: JSONObject, resource: JSONObject, operation: String): String {
        val requestId = request.getString("requestId")
        if (pendingResolutions.containsKey(requestId)) throw ProviderFailure("provider.protocol_error")
        val symlinks = symlinkMode(request)
        val source = resolution.request(resource.getJSONArray("pathSegments").strings(), operation, symlinks)
        val destination = if (operation != "filesystem.entry.rename") null else resolution.request(
            segmentsFromUrl(request.arguments().getString("to"), resource.getString("rootId")),
            operation,
            symlinks,
        )
        val plan = AndroidFilesystemResolutionPlan(listOfNotNull(source, destination))
        pendingResolutions[requestId] = plan
        return success(
            JSONObject().put("requests", org.json.JSONArray(plan.requests.map { resolutionRequestJson(it.snapshot) })),
        )
    }

    private fun verify(request: JSONObject): String {
        val plan = pendingResolutions[request.getString("requestId")] ?: throw ProviderFailure("resource.stale")
        val index = request.getInt("resolutionIndex")
        val current = plan.requests.getOrNull(index)?.let(resolution::verify)
            ?: throw ProviderFailure("provider.protocol_error")
        return success(
            JSONObject()
                .put("evidence", current.evidence)
                .put("resolvedVirtualUrl", current.resolvedVirtualUrl),
        )
    }

    private fun validateExecution(
        request: JSONObject,
        plan: AndroidFilesystemResolutionPlan,
    ): List<AndroidFilesystemResolutionSnapshot> {
        val tokens = request.getJSONArray("resolutionTokens")
        val resources = request.getJSONArray("resolutionResources")
        val authorities = request.getJSONArray("resolutionAuthorityBindings")
        if (tokens.length() != plan.requests.size || resources.length() != plan.requests.size ||
            authorities.length() != plan.requests.size
        ) throw ProviderFailure("provider.protocol_error")
        return plan.requests.mapIndexed { index, resolutionRequest ->
            val current = resolution.verify(resolutionRequest)
            val token = tokens.getJSONObject(index)
            val resolvedResource = resources.getJSONObject(index)
            if (
                token.getLong("generation") != generation ||
                token.getString("parentRequestId") != request.getString("requestId") ||
                token.getString("resolvedSemanticDigest") != resolvedResource.getString("semanticResourceDigest") ||
                token.getString("evidenceDigest") != resolution.evidenceDigest(current.evidence) ||
                current.resolvedVirtualUrl != resolvedResource.getString("virtualUrl")
            ) throw ProviderFailure("resource.invalid")
            current
        }
    }

    private fun resolutionRequestJson(snapshot: AndroidFilesystemResolutionSnapshot) = JSONObject()
        .put("evidence", snapshot.evidence)
        .put("reason", "filesystemTarget")
        .put("resolvedVirtualUrl", snapshot.resolvedVirtualUrl)
        .put("sideEffectCount", 0)

    private fun invokeResource(request: JSONObject, operation: String, bindingId: String): String {
        if (operation == "filesystem.watch.close") {
            requireAuthority(request, "watch")
            resources.release(bindingId)
            return success(JSONObject())
        }
        val handle = resources.require(bindingId) as? AndroidFileHandleResource
            ?: throw ProviderFailure("resource.stale")
        return when (operation) {
            "filesystem.file.close" -> {
                resources.release(bindingId)
                success(JSONObject())
            }
            "filesystem.file.read" -> {
                require("read" in handle.rights)
                val positioned = positioned(request, "positionedRead")
                val bytes = if (positioned == null) {
                    val length = handle.file.length()
                    if (length > Int.MAX_VALUE) throw ProviderFailure("resource.byte_limit")
                    requireLimit(request, "maxReadBytes", length.toInt())
                    ByteArray(length.toInt()).also { value ->
                        handle.file.seek(0)
                        handle.file.readFully(value)
                    }
                } else {
                    val size = positioned.size ?: throw ProviderFailure("argument.invalid")
                    requireLimit(request, "maxReadBytes", size)
                    val available = (handle.file.length() - positioned.offset).coerceAtLeast(0)
                    val targetSize = minOf(size.toLong(), available).toInt()
                    val value = ByteArray(targetSize)
                    handle.file.seek(positioned.offset)
                    val count = if (targetSize == 0) 0 else handle.file.read(value)
                    if (count < 0) ByteArray(0) else value.copyOf(count)
                }
                success(encodeFilesystemData(bytes, filesystemEncoding(request.arguments().optJSONObject("options"))))
            }
            "filesystem.file.write" -> {
                require("write" in handle.rights)
                val data = decodeFilesystemData(request.arguments().get("data"))
                requireLimit(request, "maxWriteBytes", data.size)
                val positioned = positioned(request, "positionedWrite")
                if (positioned != null) {
                    handle.file.seek(positioned.offset)
                } else if (handle.append) handle.file.seek(handle.file.length()) else {
                    handle.file.seek(0)
                    handle.file.setLength(0)
                }
                handle.file.write(data)
                handle.file.fd.sync()
                success(JSONObject())
            }
            "filesystem.metadata.stat" -> success(stat(handle.path, followLinks = true))
            else -> throw ProviderFailure("provider.unavailable")
        }
    }

    private fun readPath(request: JSONObject, target: File): String {
        requireAuthority(request, "read")
        if (!target.isFile) throw ProviderFailure("resource.not_found")
        val bytes = target.readBytes()
        requireLimit(request, "maxReadBytes", bytes.size)
        return success(encodeFilesystemData(bytes, filesystemEncoding(request.arguments().optJSONObject("options"))))
    }

    private fun writePath(request: JSONObject, target: File): String {
        requireAuthority(request, "write")
        val arguments = request.arguments()
        val data = decodeFilesystemData(arguments.get("data"))
        requireLimit(request, "maxWriteBytes", data.size)
        val options = arguments.optJSONObject("options")
        filesystemCharset(options)
        val flag = options?.optString("flag", "w") ?: "w"
        if (target.parentFile?.isDirectory != true) throw ProviderFailure("resource.not_found")
        if (flag == "a" || flag == "ax") {
            if (flag == "ax" && target.exists()) throw ProviderFailure("resource.exists")
            FileOutputStream(target, true).use { output ->
                output.write(data)
                output.fd.sync()
            }
        } else {
            if (flag == "wx" && target.exists()) throw ProviderFailure("resource.exists")
            atomicReplace(target, data, exclusive = flag == "wx")
        }
        return success(JSONObject())
    }

    private fun atomicReplace(target: File, data: ByteArray, exclusive: Boolean) {
        val temporary = File.createTempFile(".holonomy-", ".tmp", target.parentFile)
        try {
            FileOutputStream(temporary).use { output ->
                output.write(data)
                output.fd.sync()
            }
            try {
                if (exclusive) {
                    Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
                } else {
                    Files.move(
                        temporary.toPath(),
                        target.toPath(),
                        StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                }
            } catch (_: FileAlreadyExistsException) {
                throw ProviderFailure("resource.exists")
            } catch (_: AtomicMoveNotSupportedException) {
                throw ProviderFailure("provider.unavailable")
            } catch (_: IOException) {
                throw ProviderFailure("provider.unavailable")
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun open(request: JSONObject, resource: JSONObject, target: File): String {
        val flag = request.arguments().getString("flag")
        val rights = flagRights(flag)
        rights.forEach { right -> requireAuthority(request, right) }
        requireHandleCapacity(request)
        val exists = target.exists()
        if (flag.startsWith("r") && !exists) throw ProviderFailure("resource.not_found")
        if (flag.contains("x") && exists) throw ProviderFailure("resource.exists")
        val handle = RandomAccessFile(target, if (rights.contains("write")) "rw" else "r")
        if (flag.startsWith("w")) handle.setLength(0)
        val fd = nextFd.getAndIncrement().toInt()
        val bindingId = "fd-$fd"
        openHandles += bindingId
        resources.publish(bindingId, AndroidFileHandleResource(flag.startsWith("a"), handle, target, rights) {
            openHandles -= bindingId
        })
        val value = if (request.getString("member") == "open" && request.getString("invocationMode") == "promise") {
            facade(bindingId, "filesystem.file-handle")
        } else {
            JSONObject().put("binding", "opaque").put("fd", fd)
        }
        return success(value, listOf(resourcePublication(bindingId, "filesystem.file-handle")))
    }

    private fun readdir(request: JSONObject, target: File): String {
        requireAuthority(request, "list")
        val entries = target.listFiles()?.sortedBy(File::getName) ?: throw ProviderFailure("resource.not_found")
        requireLimit(request, "maxDirectoryEntries", entries.size)
        val withTypes = request.arguments().optJSONObject("options")?.optBoolean("withFileTypes", false) == true
        val value = org.json.JSONArray()
        for (entry in entries) {
            value.put(if (!withTypes) entry.name else JSONObject()
                .put("kind", if (Files.isSymbolicLink(entry.toPath())) "symlink" else if (entry.isDirectory) "directory" else "file")
                .put("name", entry.name))
        }
        return success(value)
    }

    private fun mkdir(request: JSONObject, resource: JSONObject, target: File): String {
        requireAuthority(request, "create")
        val recursive = request.arguments().optJSONObject("options")?.optBoolean("recursive", false) == true
        val existed = target.exists()
        val segments = resource.getJSONArray("pathSegments").strings()
        var current = workspace
        var firstMissingIndex: Int? = null
        for ((index, segment) in segments.withIndex()) {
            current = File(current, segment)
            if (firstMissingIndex == null && !current.exists()) firstMissingIndex = index
        }
        val created = if (recursive) target.mkdirs() || target.isDirectory else target.mkdir()
        if (!created) {
            if (!recursive || !target.isDirectory) throw ProviderFailure(if (existed) "resource.exists" else "resource.not_found")
        }
        val result = if (!recursive) JSONObject() else if (existed) {
            JSONObject().put("kind", "undefined")
        } else {
            val createdIndex = firstMissingIndex ?: throw ProviderFailure("provider.protocol_error")
            JSONObject().put("kind", "path").put("value", virtualUrl(segments.take(createdIndex + 1)))
        }
        return success(result)
    }

    private fun rename(request: JSONObject, resource: JSONObject, source: File, destination: File?): String {
        requireAuthority(request, "move")
        val target = destination ?: throw ProviderFailure("provider.protocol_error")
        requireAuthority(request, "move", request.getJSONArray("resolutionAuthorityBindings").getJSONArray(1))
        if (!source.renameTo(target)) throw ProviderFailure("provider.unavailable")
        return success(JSONObject())
    }

    private fun unlink(target: File): String {
        if (!target.exists()) throw ProviderFailure("resource.not_found")
        if (target.isDirectory || !target.delete()) throw ProviderFailure("provider.unavailable")
        return success(JSONObject())
    }

    private fun watch(request: JSONObject, resource: JSONObject, target: File): String {
        requireAuthority(request, "watch")
        requireWatcherCapacity(request)
        val maxQueuedEvents = watchQueueLimit(request)
        if (!target.exists()) throw ProviderFailure("resource.not_found")
        val bindingId = "android-watch-${nextBinding.getAndIncrement()}"
        openWatchers += bindingId
        resources.publish(bindingId, AndroidFileWatcherResource(target) { openWatchers -= bindingId })
        val type = if (request.getString("module") == "node:fs/promises") {
            "filesystem.watch-iterator"
        } else {
            "filesystem.watcher"
        }
        return success(
            facade(bindingId, type).put("maxQueuedEvents", maxQueuedEvents),
            listOf(resourcePublication(bindingId, type, "VirtualFsWatcherDeliveryV1")),
        )
    }

    private fun requireAuthority(
        request: JSONObject,
        right: String,
        bindings: org.json.JSONArray = request.getJSONArray("authorityBindings"),
    ) {
        val resource = request.getJSONObject("resource")
        val authorized = bindings.objects().any { binding ->
            if (binding.getString("providerModule") != "host.fs") return@any false
            binding.getJSONObject("constraints").getJSONArray("roots").objects().any { root ->
                root.getString("rootId") == resource.getString("rootId") &&
                    root.getJSONArray("rights").strings().contains(right)
            }
        }
        if (!authorized) throw ProviderFailure("capability.denied")
    }

    private fun symlinkMode(request: JSONObject): String = request.getJSONArray("authorityBindings").objects()
        .asSequence()
        .filter { it.getString("providerModule") == "host.fs" }
        .flatMap { it.getJSONObject("constraints").getJSONArray("roots").objects().asSequence() }
        .first { it.getString("rootId") == WORKSPACE_ROOT_ID }
        .getString("symlinks")

    private fun segmentsFromUrl(url: String, rootId: String): List<String> {
        val prefix = "holo-fs://$rootId/"
        if (rootId != WORKSPACE_ROOT_ID || !url.startsWith(prefix)) throw ProviderFailure("resource.cross_root")
        val segments = url.removePrefix(prefix).split('/')
        if (segments.isEmpty() || segments.any { !validSegment(it) }) throw ProviderFailure("resource.invalid")
        return segments
    }

    private fun requireLimit(request: JSONObject, name: String, actual: Int) {
        val maximum = request.fsLimits().getInt(name)
        if (actual > maximum) throw ProviderFailure("resource.byte_limit")
    }

    private fun requireHandleCapacity(request: JSONObject) {
        if (openHandles.size >= request.fsLimits().getInt("maxOpenHandles")) {
            throw ProviderFailure("resource.handle_limit")
        }
    }

    private fun requireWatcherCapacity(request: JSONObject) {
        if (openWatchers.size >= request.fsLimits().getInt("maxWatchers")) {
            throw ProviderFailure("resource.handle_limit")
        }
    }

    private fun watchQueueLimit(request: JSONObject): Int {
        val maximum = request.fsLimits().getInt("maxQueuedEvents")
        val requested = request.arguments().optJSONObject("options")?.let { options ->
            if (options.has("maxQueuedEvents")) options.getInt("maxQueuedEvents") else null
        }
        if (maximum < 1) throw ProviderFailure("resource.handle_limit")
        if (requested != null && (requested < 1 || requested > maximum)) {
            throw ProviderFailure("argument.invalid")
        }
        return requested ?: maximum
    }

    private fun positioned(request: JSONObject, kind: String): PositionedFilesystemRequest? {
        val value = request.optJSONObject("providerData") ?: return null
        val keys = if (kind == "positionedRead") arrayOf("kind", "offset", "size") else arrayOf("kind", "offset")
        value.requireOnlyKeys(*keys)
        if (value.getString("kind") != kind) throw ProviderFailure("argument.invalid")
        val offset = value.getLong("offset")
        if (offset < 0) throw ProviderFailure("argument.invalid")
        val size = if (kind == "positionedRead") value.getLong("size") else null
        if (size != null && (size < 0 || size > Int.MAX_VALUE)) throw ProviderFailure("argument.invalid")
        return PositionedFilesystemRequest(offset, size?.toInt())
    }

    private fun stat(file: File, followLinks: Boolean): JSONObject {
        if (!file.exists() && !(Files.isSymbolicLink(file.toPath()) && !followLinks)) throw ProviderFailure("resource.not_found")
        val attributes = if (followLinks) Files.readAttributes(file.toPath(), java.nio.file.attribute.BasicFileAttributes::class.java)
        else Files.readAttributes(
            file.toPath(),
            java.nio.file.attribute.BasicFileAttributes::class.java,
            java.nio.file.LinkOption.NOFOLLOW_LINKS,
        )
        return JSONObject()
            .put("birthtimeMs", attributes.creationTime().toMillis().coerceAtLeast(0))
            .put("ctimeMs", attributes.lastModifiedTime().toMillis().coerceAtLeast(0))
            .put("kind", if (attributes.isSymbolicLink) "symlink" else if (attributes.isDirectory) "directory" else "file")
            .put("mtimeMs", attributes.lastModifiedTime().toMillis().coerceAtLeast(0))
            .put("size", attributes.size().coerceAtLeast(0))
    }

    private fun flagRights(flag: String): Set<String> = when {
        flag.contains('+') -> setOf("read", "write")
        flag.startsWith('r') -> setOf("read")
        else -> setOf("write")
    }

    private fun facade(bindingId: String, type: String) = JSONObject()
        .put("binding", JSONObject().put("bindingId", bindingId).put("generation", generation))
        .put("resourceType", type)

    private fun virtualUrl(segments: List<String>) = "holo-fs://$WORKSPACE_ROOT_ID/${segments.joinToString("/")}"

    private fun validSegment(value: String): Boolean = value.isNotEmpty() && value != "." && value != ".." &&
        !value.contains('/') && !value.contains('\\') && !value.contains('\u0000')

    private fun JSONObject.arguments() = getJSONObject("arguments")
    private fun JSONObject.fsLimits() = getJSONArray("authorityBindings").objects()
        .first { binding -> binding.getString("providerModule") == "host.fs" }
        .getJSONObject("constraints")
        .getJSONObject("limits")

    private companion object {
        private const val WORKSPACE_ROOT_ID = "workspace"
    }
}

private data class PositionedFilesystemRequest(val offset: Long, val size: Int?)
private data class AndroidFilesystemResolutionPlan(val requests: List<AndroidFilesystemResolutionRequest>)
