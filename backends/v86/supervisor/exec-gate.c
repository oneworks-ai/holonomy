#include "exec-gate.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <time.h>
#include <unistd.h>

#define HOLO_EXEC_MAX_ARGUMENTS 256U
#define HOLO_EXEC_MAX_STRING 4096U

struct holo_payload {
    uint8_t *bytes;
    size_t capacity;
    size_t length;
};

static int64_t monotonic_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
    return (int64_t)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0 ? -1 : 0;
}

static int send_listener(int socket_fd, int listener_fd) {
    uint8_t status = 1;
    char control[CMSG_SPACE(sizeof(int))];
    struct iovec iov = { &status, sizeof(status) };
    struct msghdr message;
    struct cmsghdr *header;
    memset(&message, 0, sizeof(message));
    memset(control, 0, sizeof(control));
    message.msg_iov = &iov;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &listener_fd, sizeof(listener_fd));
    return sendmsg(socket_fd, &message, 0) == (ssize_t)sizeof(status) ? 0 : -1;
}

static int receive_listener(int socket_fd) {
    uint8_t status;
    char control[CMSG_SPACE(sizeof(int))];
    struct iovec iov = { &status, sizeof(status) };
    struct msghdr message;
    struct cmsghdr *header;
    int listener_fd = -1;
    memset(&message, 0, sizeof(message));
    memset(control, 0, sizeof(control));
    message.msg_iov = &iov;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    if (recvmsg(socket_fd, &message, 0) != (ssize_t)sizeof(status) || status != 1) return -1;
    header = CMSG_FIRSTHDR(&message);
    if (
        header == NULL || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS ||
        header->cmsg_len != CMSG_LEN(sizeof(int))
    ) return -1;
    memcpy(&listener_fd, CMSG_DATA(header), sizeof(listener_fd));
    return listener_fd;
}

static int respond(int listener_fd, uint64_t id, int allowed) {
    struct seccomp_notif_resp response;
    memset(&response, 0, sizeof(response));
    response.id = id;
    if (allowed) {
        response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
    } else {
        response.error = -EPERM;
    }
    if (ioctl(listener_fd, SECCOMP_IOCTL_NOTIF_SEND, &response) == 0) return 0;
    return errno == ENOENT ? 0 : -1;
}

void holo_exec_gate_init(struct holo_exec_gate *gate) {
    memset(gate, 0, sizeof(*gate));
    gate->listener_fd = -1;
}

int holo_exec_gate_prepare_child(int socket_fd) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_I386, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execve, 1, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_execveat, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = {
        .filter = instructions,
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0]))
    };
    int listener_fd;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    listener_fd = (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
    if (listener_fd < 0) return -1;
    if (send_listener(socket_fd, listener_fd) != 0) {
        close(listener_fd);
        return -1;
    }
    close(listener_fd);
    return 0;
}

int holo_exec_gate_prepare_parent(int socket_fd, pid_t root_pid, struct holo_exec_gate *gate) {
    int listener_fd = receive_listener(socket_fd);
    if (listener_fd < 0) return -1;
    if (set_nonblocking(listener_fd) != 0) {
        close(listener_fd);
        return -1;
    }
    gate->listener_fd = listener_fd;
    gate->initial_pid = root_pid;
    return 0;
}

static int remote_read(pid_t pid, uintptr_t address, void *output, size_t length) {
    struct iovec local = { output, length };
    struct iovec remote = { (void *)address, length };
    char path[64];
    int fd;
    ssize_t count;
    if (syscall(SYS_process_vm_readv, pid, &local, 1, &remote, 1, 0) == (ssize_t)length) return 0;
    snprintf(path, sizeof(path), "/proc/%d/mem", pid);
    fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    count = pread(fd, output, length, (off_t)address);
    close(fd);
    return count == (ssize_t)length ? 0 : -1;
}

static char *remote_string(pid_t pid, uintptr_t address) {
    char *output = malloc(HOLO_EXEC_MAX_STRING + 1U);
    size_t index;
    if (output == NULL || address == 0) {
        free(output);
        return NULL;
    }
    for (index = 0; index < HOLO_EXEC_MAX_STRING; index += 1) {
        if (remote_read(pid, address + index, &output[index], 1) != 0) {
            free(output);
            return NULL;
        }
        if (output[index] == 0) return output;
    }
    free(output);
    return NULL;
}

static int payload_reserve(struct holo_payload *payload, size_t extra) {
    size_t required = payload->length + extra;
    size_t capacity = payload->capacity == 0 ? 256 : payload->capacity;
    uint8_t *bytes;
    if (required > HOLO_MAX_FRAME_BYTES - HOLO_HEADER_BYTES) return -1;
    while (capacity < required) capacity *= 2;
    if (capacity == payload->capacity) return 0;
    bytes = realloc(payload->bytes, capacity);
    if (bytes == NULL) return -1;
    payload->bytes = bytes;
    payload->capacity = capacity;
    return 0;
}

static int payload_u16(struct holo_payload *payload, uint16_t value) {
    if (payload_reserve(payload, 2) != 0) return -1;
    payload->bytes[payload->length++] = (uint8_t)(value >> 8U);
    payload->bytes[payload->length++] = (uint8_t)value;
    return 0;
}

static int payload_u32(struct holo_payload *payload, uint32_t value) {
    if (payload_reserve(payload, 4) != 0) return -1;
    holo_u32_write(payload->bytes + payload->length, value);
    payload->length += 4;
    return 0;
}

static int payload_string(struct holo_payload *payload, const char *value) {
    size_t length = strlen(value);
    if (length == 0 || length > HOLO_EXEC_MAX_STRING || payload_reserve(payload, 4 + length) != 0) return -1;
    holo_u32_write(payload->bytes + payload->length, (uint32_t)length);
    payload->length += 4;
    memcpy(payload->bytes + payload->length, value, length);
    payload->length += length;
    return 0;
}

static pid_t parent_pid(pid_t pid) {
    char path[64];
    char line[256];
    FILE *stream;
    snprintf(path, sizeof(path), "/proc/%d/status", pid);
    stream = fopen(path, "r");
    if (stream == NULL) return -1;
    while (fgets(line, sizeof(line), stream) != NULL) {
        int value;
        if (sscanf(line, "PPid:%d", &value) == 1) {
            fclose(stream);
            return (pid_t)value;
        }
    }
    fclose(stream);
    return -1;
}

static char *process_cwd(pid_t pid) {
    char path[64];
    char *output = malloc(HOLO_EXEC_MAX_STRING + 1U);
    ssize_t length;
    if (output == NULL) return NULL;
    snprintf(path, sizeof(path), "/proc/%d/cwd", pid);
    length = readlink(path, output, HOLO_EXEC_MAX_STRING);
    if (length <= 0 || (size_t)length >= HOLO_EXEC_MAX_STRING) {
        free(output);
        return NULL;
    }
    output[length] = 0;
    return output;
}

static int append_arguments(
    struct holo_payload *payload,
    pid_t pid,
    uintptr_t argv_address
) {
    char *arguments[HOLO_EXEC_MAX_ARGUMENTS];
    uint16_t count = 0;
    uint16_t index;
    uint32_t remote_address;
    memset(arguments, 0, sizeof(arguments));
    while (count < HOLO_EXEC_MAX_ARGUMENTS) {
        if (remote_read(pid, argv_address + (uintptr_t)count * sizeof(remote_address), &remote_address, sizeof(remote_address)) != 0) goto fail;
        if (remote_address == 0) break;
        arguments[count] = remote_string(pid, remote_address);
        if (arguments[count] == NULL) goto fail;
        count += 1;
    }
    if (count == 0 || count == HOLO_EXEC_MAX_ARGUMENTS || payload_u16(payload, count) != 0) goto fail;
    for (index = 0; index < count; index += 1) {
        if (payload_string(payload, arguments[index]) != 0) goto fail;
        free(arguments[index]);
    }
    return 0;
fail:
    for (index = 0; index < count; index += 1) free(arguments[index]);
    return -1;
}

static int capture_payload(
    pid_t pid,
    uintptr_t path_address,
    uintptr_t argv_address,
    struct holo_payload *payload
) {
    char *path = remote_string(pid, path_address);
    char *cwd = process_cwd(pid);
    pid_t ppid = parent_pid(pid);
    int result = -1;
    if (path == NULL || cwd == NULL || ppid <= 0 || path[0] != '/') goto done;
    if (
        payload_u32(payload, (uint32_t)pid) != 0 || payload_u32(payload, (uint32_t)ppid) != 0 ||
        payload_string(payload, path) != 0 || payload_string(payload, cwd) != 0 ||
        append_arguments(payload, pid, argv_address) != 0
    ) goto done;
    result = 0;
done:
    free(path);
    free(cwd);
    return result;
}

static void clear_pending(struct holo_exec_gate *gate) {
    free(gate->snapshot);
    gate->snapshot = NULL;
    gate->snapshot_length = 0;
    gate->notification_pid = 0;
    gate->path_address = 0;
    gate->argv_address = 0;
    gate->pending = 0;
    gate->notification_id = 0;
    gate->request_id = 0;
    gate->deadline_ms = 0;
}

static int exec_addresses(
    const struct seccomp_data *data,
    uintptr_t *path_address,
    uintptr_t *argv_address
) {
    uint64_t path;
    uint64_t argv;
    if (data->nr == __NR_execve) {
        path = data->args[0];
        argv = data->args[1];
    } else if (data->nr == __NR_execveat) {
        /* v1 accepts only the absolute-path form. Relative dirfd and AT_EMPTY_PATH remain denied. */
        if ((int32_t)(uint32_t)data->args[0] != AT_FDCWD || data->args[4] != 0) return -1;
        path = data->args[1];
        argv = data->args[2];
    } else {
        return -1;
    }
    if (path == 0 || argv == 0 || path > UINT32_MAX || argv > UINT32_MAX) return -1;
    *path_address = (uintptr_t)path;
    *argv_address = (uintptr_t)argv;
    return 0;
}

int holo_exec_gate_poll_event(struct holo_exec_gate *gate, int control_fd, uint32_t process_id,
                              uint32_t request_id, uint32_t timeout_ms) {
    struct seccomp_notif notification;
    struct holo_payload payload = { 0 };
    uintptr_t path_address;
    uintptr_t argv_address;
    int64_t now;
    int result = -1;
    if (gate->listener_fd < 0 || gate->pending) return -1;
    memset(&notification, 0, sizeof(notification));
    if (ioctl(gate->listener_fd, SECCOMP_IOCTL_NOTIF_RECV, &notification) != 0) {
        /*
         * The listener can retain a readable edge after a prior notification
         * was continued. The kernel reports ENOENT when that notification no
         * longer exists; it is not a broken listener or an admission failure.
         */
        return errno == EAGAIN || errno == EINTR || errno == ENOENT ? 0 : -1;
    }
    if (notification.data.arch != AUDIT_ARCH_I386) {
        return respond(gate->listener_fd, notification.id, 0);
    }
    if (gate->initial_pid > 0) {
        int allowed = notification.pid == (uint32_t)gate->initial_pid;
        gate->initial_pid = 0;
        return respond(gate->listener_fd, notification.id, allowed);
    }
    if (exec_addresses(&notification.data, &path_address, &argv_address) != 0) goto deny;
    if (capture_payload(
        (pid_t)notification.pid,
        path_address,
        argv_address,
        &payload
    ) != 0) goto deny;
    now = monotonic_ms();
    if (now < 0 || holo_write_frame(
        control_fd,
        HOLO_EXEC_REQUEST,
        request_id,
        process_id,
        0,
        payload.bytes,
        (uint32_t)payload.length
    ) != 0) goto deny;
    gate->notification_id = notification.id;
    gate->request_id = request_id;
    gate->notification_pid = (pid_t)notification.pid;
    gate->path_address = path_address;
    gate->argv_address = argv_address;
    gate->snapshot = payload.bytes;
    gate->snapshot_length = payload.length;
    payload.bytes = NULL;
    gate->pending = 1;
    gate->deadline_ms = now + timeout_ms;
    result = 0;
    goto done;
deny:
    result = respond(gate->listener_fd, notification.id, 0);
done:
    free(payload.bytes);
    return result;
}

int holo_exec_gate_response(struct holo_exec_gate *gate, const struct holo_frame *frame) {
    struct holo_payload current = { 0 };
    int allowed;
    int result;
    if (!gate->pending || gate->request_id != frame->request_id || frame->payload_length != 1 || frame->payload[0] > 1) {
        dprintf(
            STDERR_FILENO,
            "holo-uvd: invalid exec response pending=%d expected=%u received=%u bytes=%u value=%u\n",
            gate->pending,
            gate->request_id,
            frame->request_id,
            frame->payload_length,
            frame->payload_length == 0 ? 255U : frame->payload[0]
        );
        errno = EPROTO;
        return -1;
    }
    allowed = frame->payload[0] == 1;
    if (allowed && (
        ioctl(gate->listener_fd, SECCOMP_IOCTL_NOTIF_ID_VALID, &gate->notification_id) != 0 ||
        capture_payload(gate->notification_pid, gate->path_address, gate->argv_address, &current) != 0 ||
        current.length != gate->snapshot_length || memcmp(current.bytes, gate->snapshot, current.length) != 0
    )) allowed = 0;
    free(current.bytes);
    result = respond(gate->listener_fd, gate->notification_id, allowed);
    if (result != 0) dprintf(STDERR_FILENO, "holo-uvd: exec response ioctl failed errno=%d\n", errno);
    clear_pending(gate);
    return result;
}

int holo_exec_gate_timeout(struct holo_exec_gate *gate) {
    int64_t now;
    int result;
    if (!gate->pending) return 0;
    now = monotonic_ms();
    if (now >= 0 && now < gate->deadline_ms) return 0;
    result = respond(gate->listener_fd, gate->notification_id, 0);
    clear_pending(gate);
    return result;
}

void holo_exec_gate_close(struct holo_exec_gate *gate) {
    if (gate->pending) respond(gate->listener_fd, gate->notification_id, 0);
    clear_pending(gate);
    if (gate->listener_fd >= 0) close(gate->listener_fd);
    holo_exec_gate_init(gate);
}
