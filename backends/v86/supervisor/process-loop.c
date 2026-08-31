#include "process-internal.h"

#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static void close_fd(int *fd) {
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

static void release_process(struct holo_process *process) {
    close_fd(&process->stdin_fd);
    close_fd(&process->stdout_fd);
    close_fd(&process->stderr_fd);
    holo_exec_gate_close(&process->exec_gate);
    free(process->input.bytes);
    free(process->executable_id);
    free(process->resource_id);
    memset(process, 0, sizeof(*process));
}

static int fail_stdin(struct holo_process *process, int control_fd, const char *code) {
    int result = 0;
    if (process->input.bytes != NULL) {
        result = holo_write_error(control_fd, process->input.request_id, process->id, code);
        free(process->input.bytes);
        memset(&process->input, 0, sizeof(process->input));
    }
    return result;
}

static int finish_if_ready(struct holo_process *process, int control_fd) {
    if (!process->exited || process->stdout_fd >= 0 || process->stderr_fd >= 0) return 0;
    if (holo_write_completion(
        control_fd,
        HOLO_CLOSE,
        process->id,
        process->exit_code,
        process->exit_signal
    ) != 0) return -1;
    release_process(process);
    return 0;
}

size_t holo_process_poll_fds(struct holo_process_table *table, struct pollfd *fds,
                             struct holo_poll_target *targets, size_t offset) {
    size_t index;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        struct holo_process *process = &table->entries[index];
        if (!process->used) continue;
        if (process->input.bytes != NULL && process->stdin_fd >= 0) {
            fds[offset] = (struct pollfd){ process->stdin_fd, POLLOUT, 0 };
            targets[offset++] = (struct holo_poll_target){ process, HOLO_POLL_STDIN };
        }
        if (process->stdout_fd >= 0) {
            fds[offset] = (struct pollfd){ process->stdout_fd, POLLIN, 0 };
            targets[offset++] = (struct holo_poll_target){ process, HOLO_POLL_STDOUT };
        }
        if (process->stderr_fd >= 0) {
            fds[offset] = (struct pollfd){ process->stderr_fd, POLLIN, 0 };
            targets[offset++] = (struct holo_poll_target){ process, HOLO_POLL_STDERR };
        }
        if (
            process->exec_gate.listener_fd >= 0 && !process->exec_gate.pending &&
            !process->exec_gate.commit_pending
        ) {
            fds[offset] = (struct pollfd){ process->exec_gate.listener_fd, POLLIN, 0 };
            targets[offset++] = (struct holo_poll_target){ process, HOLO_POLL_EXEC };
        }
    }
    return offset;
}

static int write_stdin(int control_fd, struct holo_process *process) {
    ssize_t count = write(
        process->stdin_fd,
        process->input.bytes + process->input.offset,
        process->input.length - process->input.offset
    );
    if (count > 0) {
        process->input.offset += (size_t)count;
        if (process->input.offset == process->input.length) {
            uint32_t request_id = process->input.request_id;
            free(process->input.bytes);
            memset(&process->input, 0, sizeof(process->input));
            return holo_write_empty(control_fd, HOLO_ACK, request_id, process->id);
        }
        return 0;
    }
    if (count < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
    fail_stdin(process, control_fd, "stdin.failed");
    close_fd(&process->stdin_fd);
    return 0;
}

static int read_stream(
    int control_fd,
    struct holo_process *process,
    enum holo_poll_stream stream,
    int drain
) {
    int *fd = stream == HOLO_POLL_STDOUT ? &process->stdout_fd : &process->stderr_fd;
    uint32_t *sequence = stream == HOLO_POLL_STDOUT
        ? &process->stdout_sequence
        : &process->stderr_sequence;
    uint8_t operation = stream == HOLO_POLL_STDOUT ? HOLO_STDOUT : HOLO_STDERR;
    uint8_t bytes[16384];
    for (;;) {
        ssize_t count = read(*fd, bytes, sizeof(bytes));
        if (count > 0) {
            int result = holo_write_frame(
                control_fd,
                operation,
                0,
                process->id,
                *sequence,
                bytes,
                (uint32_t)count
            );
            if (result != 0) return result;
            *sequence += 1;
            if (drain) continue;
            return 0;
        }
        if (count < 0 && errno == EINTR) continue;
        if (count == 0 || (count < 0 && errno != EAGAIN)) close_fd(fd);
        return finish_if_ready(process, control_fd);
    }
}

int holo_process_poll_event(int control_fd, const struct pollfd *fd, const struct holo_poll_target *target) {
    if (fd->revents == 0 || !target->process->used) return 0;
    if (target->stream == HOLO_POLL_STDIN) return write_stdin(control_fd, target->process);
    if (target->stream == HOLO_POLL_EXEC) return -1;
    return read_stream(
        control_fd,
        target->process,
        target->stream,
        (fd->revents & (POLLERR | POLLHUP)) != 0
    );
}

int holo_process_exec_poll_event(
    struct holo_process_table *table,
    int control_fd,
    const struct pollfd *fd,
    const struct holo_poll_target *target,
    uint32_t timeout_ms
) {
    uint32_t request_id;
    if (fd->revents == 0 || !target->process->used || target->stream != HOLO_POLL_EXEC) return 0;
    request_id = table->next_exec_request_id++;
    if (request_id == 0) request_id = table->next_exec_request_id++;
    return holo_exec_gate_poll_event(
        &target->process->exec_gate,
        control_fd,
        target->process->id,
        request_id,
        timeout_ms
    );
}

int holo_process_exec_timeouts(struct holo_process_table *table, int control_fd) {
    size_t index;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        struct holo_process *process = &table->entries[index];
        if (
            process->used &&
            holo_exec_gate_progress(&process->exec_gate, control_fd, process->id) != 0
        ) return -1;
    }
    return 0;
}

int holo_process_reap(struct holo_process_table *table, int control_fd) {
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        size_t index;
        struct holo_process *process = NULL;
        for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
            if (table->entries[index].used && table->entries[index].pid == pid) {
                process = &table->entries[index];
                break;
            }
        }
        if (process == NULL) continue;
        process->exited = 1;
        process->exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        process->exit_signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
        close_fd(&process->stdin_fd);
        if (fail_stdin(process, control_fd, "stdin.process_exited") != 0) return -1;
        if (holo_write_completion(
            control_fd,
            HOLO_EXIT,
            process->id,
            process->exit_code,
            process->exit_signal
        ) != 0 || finish_if_ready(process, control_fd) != 0) return -1;
    }
    return pid < 0 && errno != ECHILD ? -1 : 0;
}

void holo_process_shutdown(struct holo_process_table *table) {
    size_t index;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        struct holo_process *process = &table->entries[index];
        if (!process->used) continue;
        kill(-process->pid, SIGKILL);
        release_process(process);
    }
}
