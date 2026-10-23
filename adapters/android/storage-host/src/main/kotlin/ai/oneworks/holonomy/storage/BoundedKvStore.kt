package ai.oneworks.holonomy.storage

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.nio.channels.FileChannel
import java.nio.charset.CodingErrorAction
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.CREATE
import java.nio.file.StandardOpenOption.READ
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.io.Closeable
import java.nio.channels.OverlappingFileLockException

internal class StorageFailure(val code: String) : RuntimeException(code)

/** Called only by the generation's one worker. Keys are data, never paths. */
internal class BoundedKvStore(root: File, namespace: String, private val limits: AndroidStorageLimits) {
    private val rootPath: Path = root.toPath().toAbsolutePath().normalize()
    private val file = rootPath.resolve("kv-${sha256(namespace.toByteArray(Charsets.UTF_8))}.bin")
    private val lockFile = rootPath.resolve("${file.fileName}.lock")
    private val temporary = rootPath.resolve("${file.fileName}.pending")

    /** Nonblocking OS lock also fences simultaneous generations/processes sharing a namespace. */
    fun acquire(): Closeable {
        checkRoot()
        if (Files.exists(lockFile, NOFOLLOW_LINKS) && !Files.isRegularFile(lockFile, NOFOLLOW_LINKS)) fail()
        val attributes = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
        val channel = FileChannel.open(lockFile, setOf(CREATE, WRITE, NOFOLLOW_LINKS), attributes)
        try {
            val lease = try { channel.tryLock() } catch (_: OverlappingFileLockException) { null }
                ?: throw StorageFailure("storage.conflict")
            return Closeable { try { lease.release() } finally { channel.close() } }
        } catch (error: Exception) {
            channel.close()
            throw error
        }
    }

    private fun checkRoot() {
        if (!Files.isDirectory(rootPath, NOFOLLOW_LINKS) || Files.isSymbolicLink(rootPath)) fail()
        // Resolve trusted Android ancestry once per operation; a replaced/symlinked root fails closed.
        if (rootPath.toRealPath() != rootPath) fail()
        val permissions = Files.getPosixFilePermissions(rootPath, NOFOLLOW_LINKS)
        if (permissions.any { it.name.startsWith("GROUP_") || it.name.startsWith("OTHERS_") }) fail()
    }

    fun read(checkActive: () -> Unit): LinkedHashMap<String, ByteArray> {
        checkActive()
        checkRoot()
        val result = linkedMapOf<String, ByteArray>()
        if (!Files.exists(file, NOFOLLOW_LINKS)) return result
        if (!Files.isRegularFile(file, NOFOLLOW_LINKS) || Files.size(file) > limits.maxStoreBytes) fail()
        try {
            FileChannel.open(file, READ, NOFOLLOW_LINKS).use { channel ->
                val total = channel.size()
                if (total !in 8..limits.maxStoreBytes.toLong()) fail()
                var consumed = 8L
                DataInputStream(Channels.newInputStream(channel)).use { input ->
                    if (input.readInt() != MAGIC) fail()
                    val count = input.readInt()
                    if (count !in 0..limits.maxEntries) fail()
                    repeat(count) {
                        checkActive()
                        val keySize = input.readInt()
                        val valueSize = input.readInt()
                        consumed += 8L + keySize.toLong() + valueSize.toLong()
                        if (keySize !in 1..limits.maxKeyBytes || valueSize !in 0..limits.maxValueBytes || consumed > total) fail()
                        val keyBytes = ByteArray(keySize).also(input::readFully)
                        val key = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(keyBytes)).toString()
                        if (result.containsKey(key)) fail()
                        val bytes = ByteArray(valueSize)
                        try {
                            input.readFully(bytes)
                            result[key] = bytes
                        } catch (error: Throwable) {
                            bytes.fill(0)
                            throw error
                        }
                    }
                    if (consumed != total || input.read() != -1) fail()
                }
            }
            return result
        } catch (error: Throwable) {
            // The caller cannot wipe a partial map when decoding never returns it.
            result.values.forEach { it.fill(0) }
            result.clear()
            throw error
        }
    }

    fun replace(values: Map<String, ByteArray>, checkActive: () -> Unit, commit: (() -> Unit) -> Unit) {
        checkRoot()
        if (values.size > limits.maxEntries) throw StorageFailure("storage.limit_exceeded")
        var size = 8L
        for ((key, value) in values) size += 8L + key.toByteArray(Charsets.UTF_8).size + value.size
        if (size > limits.maxStoreBytes) throw StorageFailure("storage.limit_exceeded")
        try {
            // Only one fixed provider-owned staging path: crash leftovers cannot grow unbounded.
            if (Files.exists(temporary, NOFOLLOW_LINKS)) {
                if (!Files.isRegularFile(temporary, NOFOLLOW_LINKS)) fail()
                Files.delete(temporary)
            }
            val attributes = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
            FileChannel.open(temporary, setOf(CREATE_NEW, WRITE, NOFOLLOW_LINKS), attributes).use { channel ->
                val output = DataOutputStream(Channels.newOutputStream(channel))
                output.writeInt(MAGIC)
                output.writeInt(values.size)
                for ((key, value) in values) {
                    checkActive()
                    val bytes = key.toByteArray(Charsets.UTF_8)
                    output.writeInt(bytes.size)
                    output.writeInt(value.size)
                    output.write(bytes)
                    output.write(value)
                }
                output.flush()
                channel.force(true)
            }
            commit {
                checkRoot()
                if (Files.exists(file, NOFOLLOW_LINKS) && !Files.isRegularFile(file, NOFOLLOW_LINKS)) fail()
                Files.move(temporary, file, ATOMIC_MOVE, REPLACE_EXISTING)
            }
        } finally {
            if (Files.isRegularFile(temporary, NOFOLLOW_LINKS)) Files.deleteIfExists(temporary)
        }
    }

    companion object {
        private const val MAGIC = 0x484b5631
        private fun fail(): Nothing = throw StorageFailure("storage.internal")
        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
