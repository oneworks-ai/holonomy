package ai.oneworks.holonomy.storage

import java.io.File

data class AndroidStorageLimits(
    val maxKeyBytes: Int = 1024,
    val maxValueBytes: Int = 1024 * 1024,
    val maxKeysPerList: Int = 1024,
    val maxPendingOperations: Int = 32,
    val maxEntries: Int = 4096,
    val maxStoreBytes: Int = 32 * 1024 * 1024,
) {
    init {
        require(maxKeyBytes in 1..1024 && maxValueBytes in 1..1024 * 1024)
        require(maxKeysPerList in 1..1024 && maxPendingOperations in 1..128)
        require(maxEntries in 1..4096 && maxStoreBytes in 16..32 * 1024 * 1024)
    }
}

/** rootDirectory is provisioned below the application's private noBackupFilesDir by the Host. */
class AndroidStorageHostConfiguration(
    val rootDirectory: File,
    val namespace: String,
    val principal: String,
    val generation: Long,
    val limits: AndroidStorageLimits = AndroidStorageLimits(),
    operations: Set<String> = KV_OPERATIONS,
) {
    val operations: Set<String> = operations.toSet()

    init {
        require(rootDirectory.isAbsolute)
        require(Regex("[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}").matches(namespace))
        require(Regex("[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}").matches(principal))
        require(generation > 0 && this.operations.isNotEmpty() && KV_OPERATIONS.containsAll(this.operations))
    }

    companion object {
        val KV_OPERATIONS: Set<String> = setOf("v1.kv.get", "v1.kv.set", "v1.kv.delete", "v1.kv.list")
    }
}
