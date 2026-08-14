package ai.oneworks.holonomy.capability

import android.os.FileObserver
import ai.oneworks.holonomy.host.RuntimeCapabilityResourceEventSink
import java.io.File
import java.io.RandomAccessFile
import org.json.JSONArray
import org.json.JSONObject

internal class AndroidFileHandleResource(
    val append: Boolean,
    val file: RandomAccessFile,
    val path: File,
    val rights: Set<String>,
    private val onClose: () -> Unit,
) : AndroidCapabilityResource {
    override fun close() {
        runCatching { file.close() }
        onClose()
    }
}

@Suppress("DEPRECATION")
internal class AndroidFileWatcherResource(
    target: File,
    private val onClose: () -> Unit,
) : EventCapabilityResource() {
    private val observer = object : FileObserver(target.absolutePath, ALL_EVENTS) {
        override fun onEvent(event: Int, path: String?) {
            val kind = when (event and ALL_EVENTS) {
                MODIFY, ATTRIB, CLOSE_WRITE -> "change"
                CREATE, DELETE, DELETE_SELF, MOVED_FROM, MOVED_TO, MOVE_SELF -> "rename"
                else -> return
            }
            emit(
                JSONObject()
                    .put("event", "change")
                    .put("tuple", JSONArray().put(kind).put(path ?: JSONObject.NULL))
                    .toString(),
            )
        }
    }

    init {
        observer.startWatching()
    }

    override fun closeResource() {
        observer.stopWatching()
        onClose()
    }
}
