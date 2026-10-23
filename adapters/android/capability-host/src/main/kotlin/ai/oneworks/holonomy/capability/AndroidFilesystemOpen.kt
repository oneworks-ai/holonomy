package ai.oneworks.holonomy.capability

import java.io.EOFException
import java.io.File
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.OpenOption
import java.nio.file.StandardOpenOption

@ConsistentCopyVisibility
internal data class AndroidFilesystemOpenFlag private constructor(
    val access: String,
    val create: Boolean,
    val exclusive: Boolean,
    val truncate: Boolean,
    val append: Boolean,
) {
    val handleRights: Set<String>
        get() = when (access) {
            "read" -> setOf("read")
            "write" -> setOf("write")
            else -> setOf("read", "write")
        }

    val requiredRights: Set<String>
        get() = if (create) handleRights + "write" else handleRights

    companion object {
        fun parse(value: Any?): AndroidFilesystemOpenFlag {
            if (value is String) return when (value) {
                "r" -> AndroidFilesystemOpenFlag("read", false, false, false, false)
                "r+" -> AndroidFilesystemOpenFlag("readWrite", false, false, false, false)
                "w" -> AndroidFilesystemOpenFlag("write", true, false, true, false)
                "w+" -> AndroidFilesystemOpenFlag("readWrite", true, false, true, false)
                "wx" -> AndroidFilesystemOpenFlag("write", true, true, true, false)
                "wx+" -> AndroidFilesystemOpenFlag("readWrite", true, true, true, false)
                "a" -> AndroidFilesystemOpenFlag("write", true, false, false, true)
                "a+" -> AndroidFilesystemOpenFlag("readWrite", true, false, false, true)
                "ax" -> AndroidFilesystemOpenFlag("write", true, true, false, true)
                "ax+" -> AndroidFilesystemOpenFlag("readWrite", true, true, false, true)
                else -> throw ProviderFailure("argument.invalid")
            }
            val fields = value as? Map<*, *> ?: throw ProviderFailure("argument.invalid")
            if (fields.keys != setOf("kind", "access", "create", "exclusive", "truncate", "append") ||
                fields["kind"] != "portable-open-v1" || fields["access"] !in setOf("read", "write", "readWrite")
            ) throw ProviderFailure("argument.invalid")
            fun boolean(name: String) = fields[name] as? Boolean ?: throw ProviderFailure("argument.invalid")
            val flag = AndroidFilesystemOpenFlag(
                fields["access"] as String,
                boolean("create"),
                boolean("exclusive"),
                boolean("truncate"),
                boolean("append"),
            )
            if (flag.exclusive && !flag.create || flag.access == "read" && (flag.truncate || flag.append)) {
                throw ProviderFailure("argument.invalid")
            }
            return flag
        }
    }
}

/** FileChannel keeps no-create and exclusive creation in the native open operation. */
internal class AndroidFilesystemOpenFile private constructor(
    private val channel: FileChannel,
    private val append: Boolean,
) : AutoCloseable {
    val isOpen: Boolean get() = channel.isOpen
    fun length(): Long = channel.size()
    fun seek(position: Long) { channel.position(position) }
    fun setLength(length: Long) { channel.truncate(length) }
    fun sync() { channel.force(true) }
    fun read(bytes: ByteArray): Int = channel.read(ByteBuffer.wrap(bytes))

    fun readFully(bytes: ByteArray) {
        val buffer = ByteBuffer.wrap(bytes)
        while (buffer.hasRemaining()) if (channel.read(buffer) < 0) throw EOFException()
    }

    fun write(bytes: ByteArray) {
        // Append also overrides a positioned-write offset, as in the other Providers.
        if (append) channel.position(channel.size())
        val buffer = ByteBuffer.wrap(bytes)
        while (buffer.hasRemaining()) channel.write(buffer)
    }

    override fun close() { channel.close() }

    companion object {
        fun open(target: File, flag: AndroidFilesystemOpenFlag): AndroidFilesystemOpenFile {
            val options = mutableSetOf<OpenOption>(LinkOption.NOFOLLOW_LINKS)
            if ("read" in flag.handleRights) options += StandardOpenOption.READ
            // Java ignores CREATE with READ alone. Creation is separately write-authorized;
            // the published handle still retains only its requested access rights.
            if ("write" in flag.requiredRights) options += StandardOpenOption.WRITE
            if (flag.exclusive) options += StandardOpenOption.CREATE_NEW
            else if (flag.create) options += StandardOpenOption.CREATE
            val channel = try {
                FileChannel.open(target.toPath(), options)
            } catch (_: NoSuchFileException) {
                throw ProviderFailure("resource.not_found")
            } catch (_: FileAlreadyExistsException) {
                throw ProviderFailure("resource.exists")
            }
            try {
                if (!Files.isRegularFile(target.toPath(), LinkOption.NOFOLLOW_LINKS)) {
                    throw ProviderFailure("provider.unavailable")
                }
                if (flag.truncate) channel.truncate(0)
                return AndroidFilesystemOpenFile(channel, flag.append)
            } catch (error: Throwable) {
                runCatching { channel.close() }
                throw error
            }
        }
    }
}

/** The resource ledger takes ownership only when publication finishes successfully. */
internal inline fun <T> publishFilesystemOpen(
    target: File,
    flag: AndroidFilesystemOpenFlag,
    publish: (AndroidFilesystemOpenFile) -> T,
): T {
    val file = AndroidFilesystemOpenFile.open(target, flag)
    try {
        return publish(file)
    } catch (error: Throwable) {
        runCatching { file.close() }
        throw error
    }
}
