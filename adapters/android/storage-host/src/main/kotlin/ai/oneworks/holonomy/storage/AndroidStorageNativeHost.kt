package ai.oneworks.holonomy.storage

import ai.oneworks.holonomy.host.RuntimeNativeBinary
import ai.oneworks.holonomy.host.RuntimeNativeEvent
import ai.oneworks.holonomy.host.RuntimeNativeEventSink
import ai.oneworks.holonomy.host.RuntimeNativeHost
import ai.oneworks.holonomy.host.RuntimeNativeResourceEventSink
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** Generation-owned asynchronous binary KV provider; it never executes IO on the runtime thread. */
class AndroidStorageNativeHost(private val configuration: AndroidStorageHostConfiguration) : RuntimeNativeHost {
    private val lock = Any()
    private var closed = false
    private val pending = mutableMapOf<String, Call>()
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
        ArrayBlockingQueue<Runnable>(configuration.limits.maxPendingOperations),
        { task -> Thread(task, "holonomy-storage-${configuration.generation}").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy())
    private val store = BoundedKvStore(configuration.rootDirectory, configuration.namespace, configuration.limits)

    private class Call(val token: String, val id: String, val sink: RuntimeNativeEventSink, val bytes: ByteArray?) {
        var active = true
        lateinit var task: Runnable
    }

    override fun configurationJson(): String = JSONObject()
        .put("principal", configuration.principal)
        .put("capabilities", JSONArray(listOf("host.storage.v1")))
        .put("storage", JSONObject().put("namespace", "default")
            .put("operations", JSONArray(configuration.operations.sorted()))
            .put("limits", JSONObject().put("maxKeyBytes", configuration.limits.maxKeyBytes)
                .put("maxValueBytes", configuration.limits.maxValueBytes)
                .put("maxKeysPerList", configuration.limits.maxKeysPerList)
                .put("maxPendingOperations", configuration.limits.maxPendingOperations)))
        .toString()

    override fun dispatch(requestId: String, requestJson: String, contextJson: String,
        binary: List<RuntimeNativeBinary>, sink: RuntimeNativeEventSink, resourceSink: RuntimeNativeResourceEventSink) {
        var owned: ByteArray? = null
        try {
            if (!SCALAR.matches(requestId) || requestJson.length > 16 * 1024 || contextJson.length > 64 * 1024) invalid()
            val request = JSONObject(requestJson)
            if (!(request.exact("id", "module", "operation", "args") ||
                request.exact("id", "module", "operation", "args", "deadlineMs"))) invalid()
            if (request.get("id") != requestId || request.get("module") != "host.storage") invalid()
            val context = JSONObject(contextJson)
            val token = context.get("callToken") as? String ?: invalid()
            if (!SCALAR.matches(token)) invalid()
            val operation = request.get("operation") as? String ?: invalid()
            val args = request.get("args") as? JSONObject ?: invalid()
            if (operation == "v1.kv.set") {
                if (binary.size != 1 || binary[0].handle != "value") invalid()
                if (binary[0].data.size > configuration.limits.maxValueBytes) limit()
                owned = binary[0].data.copyOf()
            } else if (binary.isNotEmpty()) invalid()
            val call = Call(token, requestId, sink, owned)
            call.task = Runnable { execute(call, operation, args, context) }
            synchronized(lock) {
                if (closed) throw StorageFailure("storage.disposed")
                if (pending.containsKey(token)) throw StorageFailure("storage.protocol_error")
                if (pending.size >= configuration.limits.maxPendingOperations) limit()
                pending[token] = call
                try { worker.execute(call.task) } catch (_: RuntimeException) {
                    pending.remove(token)
                    limit()
                }
            }
        } catch (error: Exception) {
            owned?.fill(0)
            safeEmit(sink, failure(requestId, (error as? StorageFailure)?.code ?: "storage.invalid_argument"))
        }
    }

    private fun execute(call: Call, operation: String, args: JSONObject, context: JSONObject) {
        var values: LinkedHashMap<String, ByteArray>? = null
        var lease: java.io.Closeable? = null
        try {
            checkActive(call)
            val authority = context.required("authority") as? JSONObject ?: denied()
            val capabilities = authority.required("capabilities") as? JSONArray ?: denied()
            if (authority.required("principal") != configuration.principal || capabilities.length() > 128 ||
                (0 until capabilities.length()).none { capabilities.get(it) == "host.storage.v1" } ||
                context.required("mode") != "result" || (context.required("resources") as? JSONArray)?.length() != 0) denied()
            if (operation.startsWith("v1.sqlite.") || operation.startsWith("v1.credential.")) {
                throw StorageFailure("storage.not_supported")
            }
            if (operation !in AndroidStorageHostConfiguration.KV_OPERATIONS) invalid()
            if (operation !in configuration.operations) denied()
            val selection = context.required("storageSelection") as? JSONObject ?: denied()
            if (!selection.exact("namespaceId", "operation", "keyPrefixes", "databases", "limits") ||
                selection.required("namespaceId") != "default" || selection.required("operation") != "storage.${operation.removePrefix("v1.")}") denied()
            val databases = selection.required("databases") as? JSONArray ?: denied()
            if (databases.length() > 64) denied()
            val limits = selection.required("limits") as? JSONObject ?: denied()
            val maxKey = selectedLimit(limits, "maxKeyBytes", configuration.limits.maxKeyBytes)
            val maxValue = selectedLimit(limits, "maxValueBytes", configuration.limits.maxValueBytes)
            val maxList = selectedLimit(limits, "maxKeysPerList", configuration.limits.maxKeysPerList)
            val maxPending = selectedLimit(limits, "maxPendingOperations", configuration.limits.maxPendingOperations)
            synchronized(lock) { if (pending.size > maxPending) limit() }
            val field = if (operation == "v1.kv.list") "prefix" else "key"
            if (!args.exact(field)) invalid()
            val key = args.get(field) as? String ?: invalid()
            val encoded = key.toByteArray(Charsets.UTF_8)
            // Reject lone surrogates that would otherwise collide after UTF-8 replacement.
            if (String(encoded, Charsets.UTF_8) != key || (field == "key" && key.isEmpty())) invalid()
            if (encoded.size > maxKey || (call.bytes?.size ?: 0) > maxValue) limit()
            if (operation == "v1.kv.set") {
                val commitment = context.required("storageValue") as? JSONObject ?: denied()
                val length = commitment.required("byteLength") as? Number ?: denied()
                if (!commitment.exact("byteLength", "sha256") || length.toDouble() != call.bytes!!.size.toDouble() ||
                    commitment.required("sha256") != BoundedKvStore.sha256(call.bytes)) denied()
            }
            val prefixes = selection.required("keyPrefixes") as? JSONArray ?: denied()
            if (prefixes.length() !in 1..64) denied()
            var allowed = false
            repeat(prefixes.length()) {
                val prefix = prefixes.get(it) as? String ?: denied()
                if (prefix.toByteArray(Charsets.UTF_8).size > 1024) denied()
                if (key.startsWith(prefix)) allowed = true
            }
            if (!allowed) denied()
            lease = store.acquire()
            values = store.read { checkActive(call) }
            val event = when (operation) {
                "v1.kv.get" -> {
                    val value = values[key]
                    if (value != null && value.size > maxValue) limit()
                    success(call.id, value?.let { true }, value?.let { listOf(RuntimeNativeBinary("value", it.copyOf())) } ?: emptyList())
                }
                "v1.kv.list" -> {
                    val keys = values.keys.filter { it.startsWith(key) }.sorted()
                    if (keys.size > maxList || keys.any { it.toByteArray(Charsets.UTF_8).size > maxKey }) limit()
                    success(call.id, JSONArray(keys))
                }
                else -> {
                    val deleted = if (operation == "v1.kv.delete") values.remove(key)?.also { it.fill(0) } != null else false
                    if (operation == "v1.kv.set") values.put(key, call.bytes!!.copyOf())?.fill(0)
                    store.replace(values, { checkActive(call) }) { replace -> synchronized(lock) { checkActive(call); replace() } }
                    success(call.id, if (operation == "v1.kv.delete") deleted else null)
                }
            }
            finish(call, event)
        } catch (error: Exception) {
            finish(call, failure(call.id, (error as? StorageFailure)?.code ?: "storage.internal"))
        } finally {
            call.bytes?.fill(0)
            values?.values?.forEach { it.fill(0) }
            runCatching { lease?.close() }
        }
    }

    private fun checkActive(call: Call) = synchronized(lock) {
        if (closed || !call.active || pending[call.token] !== call) throw StorageFailure("storage.cancelled")
    }

    private fun finish(call: Call, event: RuntimeNativeEvent) = synchronized(lock) {
        if (!closed && call.active && pending[call.token] === call) {
            call.active = false
            pending.remove(call.token)
            safeEmit(call.sink, event)
        } else event.binary.forEach { it.data.fill(0) }
    }

    override fun cancel(callToken: String, reason: String?) = synchronized(lock) {
        val call = pending.remove(callToken) ?: return@synchronized
        call.active = false
        if (worker.remove(call.task)) call.bytes?.fill(0)
    }

    override fun close() = synchronized(lock) {
        if (!closed) {
            closed = true
            pending.values.forEach { it.active = false; if (worker.remove(it.task)) it.bytes?.fill(0) }
            pending.clear()
            worker.shutdownNow()
        }
    }

    private fun selectedLimit(limits: JSONObject, name: String, host: Int): Int {
        val number = limits.required(name) as? Number ?: denied()
        val value = number.toDouble()
        if (!value.isFinite() || value < 1 || value > Int.MAX_VALUE || value % 1.0 != 0.0) denied()
        return minOf(value.toInt(), host)
    }

    private fun safeEmit(sink: RuntimeNativeEventSink, event: RuntimeNativeEvent) {
        try { sink.emit(event) } catch (_: Exception) { event.binary.forEach { it.data.fill(0) } }
    }

    private fun success(id: String, value: Any?, binary: List<RuntimeNativeBinary> = emptyList()) = RuntimeNativeEvent(
        JSONObject().put("id", id).put("type", "result").put("value", JSONObject().put("ok", true)
            .put("value", value ?: JSONObject.NULL)).toString(), binary)

    private fun failure(id: String, code: String) = RuntimeNativeEvent(JSONObject().put("id", id).put("type", "result")
        .put("value", JSONObject().put("ok", false).put("error", JSONObject().put("code", code))).toString())

    private fun JSONObject.exact(vararg keys: String) = length() == keys.size && keys.all(::has)
    private fun JSONObject.required(key: String): Any = if (has(key)) get(key) else denied()
    private fun invalid(): Nothing = throw StorageFailure("storage.invalid_argument")
    private fun denied(): Nothing = throw StorageFailure("storage.authorization_denied")
    private fun limit(): Nothing = throw StorageFailure("storage.limit_exceeded")

    companion object { private val SCALAR = Regex("[A-Za-z0-9:._-]{1,128}") }
}
