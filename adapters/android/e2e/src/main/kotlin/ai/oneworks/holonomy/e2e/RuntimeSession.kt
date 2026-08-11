package ai.oneworks.holonomy.e2e

import ai.oneworks.holonomy.host.RuntimeModuleResolver
import ai.oneworks.holonomy.host.RuntimeModuleSource
import ai.oneworks.holonomy.host.RuntimeOutputStream
import ai.oneworks.holonomy.host.RuntimeProcessConfiguration
import ai.oneworks.holonomy.host.RuntimeProcessHost
import android.util.Log
import java.io.File
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

internal data class RuntimeSession(
    val argv: List<String>,
    val entryUrl: String,
    val env: Map<String, String>,
    val inspectorSocket: String?,
    val modules: Map<String, RuntimeModuleSource>,
    val waitForDebugger: Boolean,
) {
    fun resolver(): RuntimeModuleResolver = RuntimeModuleResolver { specifier, referrerUrl ->
        val canonical = runCatching {
            val candidate = URI(specifier)
            if (candidate.isAbsolute) candidate else URI(requireNotNull(referrerUrl)).resolve(candidate)
        }.getOrNull()?.normalize()?.toString()
        canonical?.let(modules::get)
    }

    companion object {
        fun read(file: File): RuntimeSession {
            require(file.length() in 1..MAX_REQUEST_BYTES) { "Runtime session exceeds the request limit" }
            val requestBytes = file.readBytes()
            require(requestBytes.size <= MAX_REQUEST_BYTES) { "Runtime session exceeds the request limit" }
            val record = JSONObject(requestBytes.toString(Charsets.UTF_8))
            require(record.getInt("schemaVersion") == 1) { "Unsupported runtime session schema" }
            val entryUrl = absoluteUrl(record.getString("entryUrl"))
            val moduleArray = record.getJSONArray("modules")
            require(moduleArray.length() in 1..MAX_MODULES) { "Invalid runtime module count" }
            val modules = LinkedHashMap<String, RuntimeModuleSource>()
            var moduleBytes = 0L
            for (index in 0 until moduleArray.length()) {
                val item = moduleArray.getJSONObject(index)
                val url = absoluteUrl(item.getString("url"))
                val source = item.getString("source")
                val sourceBytes = source.toByteArray(Charsets.UTF_8).size
                require(sourceBytes <= MAX_MODULE_BYTES) { "Runtime module is too large" }
                moduleBytes += sourceBytes
                require(moduleBytes <= MAX_MODULE_GRAPH_BYTES) { "Runtime module graph exceeds the session limit" }
                require(modules.put(url, RuntimeModuleSource(url, source)) == null) { "Duplicate runtime module URL" }
            }
            require(modules.containsKey(entryUrl)) { "Runtime entry module is missing" }
            val inspector = record.optJSONObject("inspector")
            return RuntimeSession(
                argv = strings(record.optJSONArray("argv") ?: JSONArray()),
                entryUrl = entryUrl,
                env = stringMap(record.optJSONObject("env") ?: JSONObject()),
                inspectorSocket = inspector?.optString("socketName")?.takeIf(String::isNotEmpty)?.also { socket ->
                    require(socket.toByteArray(Charsets.UTF_8).size <= MAX_SOCKET_NAME_BYTES) {
                        "Inspector socket name exceeds the session limit"
                    }
                },
                modules = modules.toMap(),
                waitForDebugger = inspector?.optBoolean("breakBeforeEntry", false) ?: false,
            )
        }

        private fun absoluteUrl(value: String): String {
            require(value.toByteArray(Charsets.UTF_8).size <= MAX_URL_BYTES) {
                "Runtime module URL exceeds the session limit"
            }
            val uri = URI(value).normalize()
            require(uri.isAbsolute && !uri.scheme.isNullOrBlank()) { "Runtime module URL must be absolute" }
            return uri.toString()
        }

        private fun strings(array: JSONArray): List<String> {
            require(array.length() <= MAX_ARGS) { "Runtime argv exceeds the session limit" }
            var aggregateBytes = 0L
            return List(array.length()) { index ->
                array.getString(index).also { argument ->
                    val argumentBytes = argument.toByteArray(Charsets.UTF_8).size
                    require(argumentBytes <= MAX_ARG_BYTES) { "Runtime argument exceeds the session limit" }
                    aggregateBytes += argumentBytes
                    require(aggregateBytes <= MAX_ARGS_BYTES) { "Runtime argv exceeds the session limit" }
                }
            }
        }

        private fun stringMap(record: JSONObject): Map<String, String> = buildMap {
            val keys = record.keys()
            var entries = 0
            var aggregateBytes = 0L
            while (keys.hasNext()) {
                val key = keys.next()
                val value = record.getString(key)
                entries += 1
                require(entries <= MAX_ENV_ENTRIES) { "Runtime env exceeds the session limit" }
                val keyBytes = key.toByteArray(Charsets.UTF_8).size
                val valueBytes = value.toByteArray(Charsets.UTF_8).size
                require(keyBytes <= MAX_ENV_KEY_BYTES && valueBytes <= MAX_ENV_VALUE_BYTES) {
                    "Runtime env entry exceeds the session limit"
                }
                aggregateBytes += keyBytes + valueBytes
                require(aggregateBytes <= MAX_ENV_BYTES) { "Runtime env exceeds the session limit" }
                put(key, value)
            }
        }

        private const val MAX_ARGS = 256
        private const val MAX_ARG_BYTES = 16 * 1024
        private const val MAX_ARGS_BYTES = 256 * 1024L
        private const val MAX_ENV_BYTES = 1024 * 1024L
        private const val MAX_ENV_ENTRIES = 256
        private const val MAX_ENV_KEY_BYTES = 256
        private const val MAX_ENV_VALUE_BYTES = 64 * 1024
        private const val MAX_MODULE_GRAPH_BYTES = 48 * 1024 * 1024L
        private const val MAX_MODULES = 512
        private const val MAX_MODULE_BYTES = 8 * 1024 * 1024
        private const val MAX_REQUEST_BYTES = 64 * 1024 * 1024L
        private const val MAX_SOCKET_NAME_BYTES = 128
        private const val MAX_URL_BYTES = 4 * 1024
    }
}

internal class FileRuntimeProcessHost(
    session: RuntimeSession,
    private val outputFile: File,
    private val onExit: (Int) -> Unit,
) : RuntimeProcessHost {
    override val configuration = RuntimeProcessConfiguration(
        argv = session.argv,
        env = session.env,
    )
    private val exited = AtomicBoolean(false)
    private val outputLimitReported = AtomicBoolean(false)
    private var outputBytes = 0L

    override fun write(stream: RuntimeOutputStream, chunk: String) {
        if (exited.get()) return
        if (chunk.length > MAX_OUTPUT_CHUNK_BYTES) {
            failOutputLimit()
            return
        }
        val chunkBytes = chunk.toByteArray(Charsets.UTF_8)
        if (chunkBytes.size > MAX_OUTPUT_CHUNK_BYTES) {
            failOutputLimit()
            return
        }
        val event = JSONObject().apply {
            put("chunk", chunk)
            put("stream", if (stream == RuntimeOutputStream.STDERR) "stderr" else "stdout")
        }
        val line = "${event}\n"
        val lineBytes = line.toByteArray(Charsets.UTF_8).size
        val admitted = synchronized(outputFile) {
            if (outputBytes + lineBytes > MAX_OUTPUT_BYTES) {
                false
            } else {
                outputFile.appendText(line)
                outputBytes += lineBytes
                true
            }
        }
        if (!admitted) {
            failOutputLimit()
            return
        }
        if (stream == RuntimeOutputStream.STDERR) Log.w(LOG_TAG, chunk.trimEnd())
        else Log.i(LOG_TAG, chunk.trimEnd())
    }

    override fun exit(code: Int) {
        if (exited.compareAndSet(false, true)) onExit(code)
    }

    private fun failOutputLimit() {
        if (outputLimitReported.compareAndSet(false, true)) {
            val event = JSONObject().apply {
                put("chunk", "Holonomy runtime output limit exceeded\n")
                put("stream", "stderr")
            }
            val line = "${event}\n"
            val lineBytes = line.toByteArray(Charsets.UTF_8).size
            synchronized(outputFile) {
                if (outputBytes + lineBytes <= MAX_OUTPUT_BYTES) {
                    outputFile.appendText(line)
                    outputBytes += lineBytes
                }
            }
        }
        exit(1)
    }

    companion object {
        private const val LOG_TAG = "HolonomyRuntime"
        private const val MAX_OUTPUT_BYTES = 16 * 1024 * 1024L
        private const val MAX_OUTPUT_CHUNK_BYTES = 1024 * 1024
    }
}
