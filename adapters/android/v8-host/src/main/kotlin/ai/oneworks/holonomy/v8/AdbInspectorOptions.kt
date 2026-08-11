package ai.oneworks.holonomy.v8

data class AdbInspectorOptions(
    val socketName: String = DEFAULT_SOCKET_NAME,
    val targetId: String = DEFAULT_TARGET_ID,
    val targetTitle: String = DEFAULT_TARGET_TITLE,
    val waitForDebugger: Boolean = false,
    val maxMessageBytes: Int = DEFAULT_MAX_MESSAGE_BYTES,
) {
    init {
        require(SOCKET_NAME.matches(socketName)) {
            "The inspector socket name must use 1-96 ASCII letters, digits, dots, dashes or underscores"
        }
        require(TARGET_ID.matches(targetId)) {
            "The inspector target id must use 1-96 ASCII letters, digits, dots, dashes or underscores"
        }
        require(targetTitle.isNotBlank() && targetTitle.length <= MAX_TARGET_TITLE_CHARS) {
            "The inspector target title must contain 1-$MAX_TARGET_TITLE_CHARS characters"
        }
        require(targetTitle.none { it.code < SPACE || it == DELETE }) {
            "The inspector target title must not contain control characters"
        }
        require(maxMessageBytes in MIN_MESSAGE_BYTES..MAX_MESSAGE_BYTES) {
            "The inspector message limit is outside the supported range"
        }
    }

    companion object {
        const val DEFAULT_MAX_MESSAGE_BYTES: Int = 64 * 1024 * 1024
        const val DEFAULT_SOCKET_NAME: String = "holonomy_devtools"
        const val DEFAULT_TARGET_ID: String = "holonomy-runtime"
        const val DEFAULT_TARGET_TITLE: String = "Holonomy Runtime"

        private const val DELETE = '\u007f'
        private const val MAX_MESSAGE_BYTES = 256 * 1024 * 1024
        private const val MAX_TARGET_TITLE_CHARS = 128
        private const val MIN_MESSAGE_BYTES = 64 * 1024
        private const val SPACE = 0x20
        private val SOCKET_NAME = Regex("[A-Za-z0-9._-]{1,96}")
        private val TARGET_ID = Regex("[A-Za-z0-9._-]{1,96}")
    }
}
