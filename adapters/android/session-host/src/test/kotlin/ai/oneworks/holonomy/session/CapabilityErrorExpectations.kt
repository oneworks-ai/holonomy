package ai.oneworks.holonomy.session

internal data class CapabilityErrorExpectation(
    val nodeFs: String,
    val nodeSystem: String,
    val holo: String,
    val childDefault: String,
    val capturedOutput: String? = null,
    val stdinWrite: String? = null,
)

internal val capabilityErrorExpectations = mapOf(
    "argument.invalid" to CapabilityErrorExpectation("EINVAL", "ERR_INVALID_ARG_VALUE", "holo.invalid_arguments", "EINVAL"),
    "capability.denied" to CapabilityErrorExpectation("EACCES", "ERR_ACCESS_DENIED", "holo.capability_denied", "EACCES"),
    "middleware.failed" to CapabilityErrorExpectation("EIO", "ERR_OPERATION_FAILED", "holo.middleware_failed", "EIO"),
    "middleware.invalid_result" to CapabilityErrorExpectation("EPROTO", "ERR_INVALID_RETURN_VALUE", "holo.invalid_result", "EPROTO"),
    "middleware.permission_denied" to CapabilityErrorExpectation("EACCES", "ERR_ACCESS_DENIED", "holo.permission_denied", "EACCES"),
    "middleware.timeout" to CapabilityErrorExpectation("ETIMEDOUT", "ERR_OPERATION_TIMEOUT", "holo.operation_timeout", "ETIMEDOUT"),
    "policy.denied" to CapabilityErrorExpectation("EACCES", "ERR_ACCESS_DENIED", "holo.policy_denied", "EACCES"),
    "provider.connection_refused" to CapabilityErrorExpectation("ECONNREFUSED", "ERR_SYSTEM_ERROR", "holo.connection_refused", "ECONNREFUSED"),
    "provider.permission_denied" to CapabilityErrorExpectation("EACCES", "ERR_ACCESS_DENIED", "holo.permission_denied", "EACCES"),
    "provider.protocol_error" to CapabilityErrorExpectation("EPROTO", "ERR_SYSTEM_ERROR", "holo.protocol_error", "EPROTO"),
    "provider.quota" to CapabilityErrorExpectation("EFBIG", "ERR_OUT_OF_RANGE", "holo.resource_exhausted", "ERR_OUT_OF_RANGE", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "EFBIG"),
    "provider.timeout" to CapabilityErrorExpectation("ETIMEDOUT", "ERR_OPERATION_TIMEOUT", "holo.operation_timeout", "ETIMEDOUT"),
    "provider.unavailable" to CapabilityErrorExpectation("EIO", "ERR_SYSTEM_ERROR", "holo.provider_unavailable", "EIO"),
    "resource.byte_limit" to CapabilityErrorExpectation("EFBIG", "ERR_OUT_OF_RANGE", "holo.resource_exhausted", "ERR_OUT_OF_RANGE", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "EFBIG"),
    "resource.cross_root" to CapabilityErrorExpectation("EXDEV", "ERR_INVALID_ARG_VALUE", "holo.invalid_arguments", "EINVAL"),
    "resource.event_limit" to CapabilityErrorExpectation("ENOSPC", "ERR_SYSTEM_ERROR", "holo.resource_exhausted", "EMFILE"),
    "resource.exists" to CapabilityErrorExpectation("EEXIST", "ERR_INVALID_STATE", "holo.already_exists", "ERR_INVALID_STATE"),
    "resource.handle_limit" to CapabilityErrorExpectation("EMFILE", "ERR_SYSTEM_ERROR", "holo.resource_exhausted", "EMFILE"),
    "resource.invalid" to CapabilityErrorExpectation("EINVAL", "ERR_INVALID_ARG_VALUE", "holo.invalid_arguments", "EINVAL"),
    "resource.not_found" to CapabilityErrorExpectation("ENOENT", "ERR_INVALID_STATE", "holo.not_found", "ENOENT"),
    "resource.stale" to CapabilityErrorExpectation("EBADF", "ERR_INVALID_STATE", "holo.generation_stale", "ERR_INVALID_STATE"),
    "result.invalid" to CapabilityErrorExpectation("EPROTO", "ERR_INVALID_RETURN_VALUE", "holo.invalid_result", "EPROTO"),
    "runtime.async_required" to CapabilityErrorExpectation("ENOSYS", "ERR_METHOD_NOT_IMPLEMENTED", "holo.async_required", "ENOSYS"),
    "runtime.cancelled" to CapabilityErrorExpectation("ABORT_ERR", "ABORT_ERR", "holo.operation_cancelled", "ABORT_ERR"),
    "runtime.generation_stale" to CapabilityErrorExpectation("EBADF", "ERR_INVALID_STATE", "holo.generation_stale", "ERR_INVALID_STATE"),
)
