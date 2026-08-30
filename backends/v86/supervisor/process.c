#include "process-internal.h"

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ? -1 : 0;
}

static void close_fd(int *fd) {
    if (*fd >= 0) close(*fd);
    *fd = -1;
}

static struct holo_process *find_process(struct holo_process_table *table, uint32_t id) {
    size_t index;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        if (table->entries[index].used && table->entries[index].id == id) return &table->entries[index];
    }
    return NULL;
}

static struct holo_process *allocate_process(struct holo_process_table *table) {
    size_t index;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        if (!table->entries[index].used) return &table->entries[index];
    }
    return NULL;
}

uint32_t holo_process_id_for_guest_pid(struct holo_process_table *table, pid_t pid) {
    pid_t group = getpgid(pid);
    size_t index;
    if (group < 0) return 0;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        struct holo_process *process = &table->entries[index];
        if (process->used && (process->pid == pid || process->pid == group)) return process->id;
    }
    return 0;
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

static int create_pipe(int enabled, int pipes[2]) {
    pipes[0] = -1;
    pipes[1] = -1;
    return !enabled || pipe(pipes) == 0 ? 0 : -1;
}

static void child_stream(int enabled, int pipes[2], int target, int input) {
    int source;
    if (enabled) {
        source = input ? pipes[0] : pipes[1];
    } else {
        source = open("/dev/null", input ? O_RDONLY : O_WRONLY);
    }
    if (source < 0 || dup2(source, target) < 0) _exit(126);
}

static void close_pipes(int pipes[3][2]) {
    size_t stream;
    for (stream = 0; stream < 3; stream += 1) {
        close_fd(&pipes[stream][0]);
        close_fd(&pipes[stream][1]);
    }
}

static void child_close_pipes(int pipes[3][2]) {
    size_t stream;
    size_t side;
    for (stream = 0; stream < 3; stream += 1) {
        for (side = 0; side < 2; side += 1) {
            if (pipes[stream][side] > STDERR_FILENO) close(pipes[stream][side]);
        }
    }
}

static pid_t launch_child(
    const struct holo_spawn_request *request,
    int pipes[3][2],
    struct holo_exec_gate *gate
) {
    int sockets[2] = { -1, -1 };
    pid_t pid;
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) != 0) return -1;
    pid = fork();
    if (pid < 0) {
        close_pipes(pipes);
        close_fd(&sockets[0]);
        close_fd(&sockets[1]);
        return -1;
    }
    if (pid != 0) {
        close_fd(&sockets[1]);
        if (holo_exec_gate_prepare_parent(sockets[0], pid, gate) != 0) {
            close_fd(&sockets[0]);
            kill(pid, SIGKILL);
            waitpid(pid, NULL, 0);
            return -1;
        }
        close_fd(&sockets[0]);
        return pid;
    }
    close_fd(&sockets[0]);
    if (setpgid(0, 0) != 0) _exit(126);
    child_stream((request->stdio_mask & 1U) != 0, pipes[0], STDIN_FILENO, 1);
    child_stream((request->stdio_mask & 2U) != 0, pipes[1], STDOUT_FILENO, 0);
    child_stream((request->stdio_mask & 4U) != 0, pipes[2], STDERR_FILENO, 0);
    child_close_pipes(pipes);
    if (setgroups(0, NULL) != 0 || setgid(1000) != 0 || setuid(1000) != 0) _exit(126);
    if (holo_exec_gate_prepare_child(sockets[1]) != 0) _exit(126);
    close_fd(&sockets[1]);
    if (chdir(request->cwd) != 0) _exit(126);
    execve(request->path, request->argv, request->envp);
    _exit(127);
}

void holo_process_table_init(struct holo_process_table *table) {
    size_t index;
    memset(table, 0, sizeof(*table));
    table->next_id = 1;
    table->next_exec_request_id = 1;
    for (index = 0; index < HOLO_MAX_PROCESSES; index += 1) {
        table->entries[index].stdin_fd = -1;
        table->entries[index].stdout_fd = -1;
        table->entries[index].stderr_fd = -1;
        holo_exec_gate_init(&table->entries[index].exec_gate);
    }
}

int holo_process_spawn(struct holo_process_table *table, int control_fd, const struct holo_frame *frame) {
    struct holo_spawn_request request;
    struct holo_process *process = allocate_process(table);
    int pipes[3][2] = { { -1, -1 }, { -1, -1 }, { -1, -1 } };
    pid_t pid;
    if (process == NULL || holo_parse_spawn(frame, &request) != 0) {
        return holo_write_error(control_fd, frame->request_id, 0, "spawn.invalid");
    }
    if (
        create_pipe((request.stdio_mask & 1U) != 0, pipes[0]) != 0 ||
        create_pipe((request.stdio_mask & 2U) != 0, pipes[1]) != 0 ||
        create_pipe((request.stdio_mask & 4U) != 0, pipes[2]) != 0
    ) {
        close_pipes(pipes);
        holo_spawn_request_free(&request);
        return holo_write_error(control_fd, frame->request_id, 0, "spawn.pipe_failed");
    }
    memset(process, 0, sizeof(*process));
    process->stdin_fd = -1;
    process->stdout_fd = -1;
    process->stderr_fd = -1;
    holo_exec_gate_init(&process->exec_gate);
    pid = launch_child(&request, pipes, &process->exec_gate);
    if (pid < 0) {
        close_pipes(pipes);
        holo_spawn_request_free(&request);
        return holo_write_error(control_fd, frame->request_id, 0, "spawn.failed");
    }
    process->used = 1;
    process->id = table->next_id++;
    process->pid = pid;
    process->stdin_fd = (request.stdio_mask & 1U) != 0 ? pipes[0][1] : -1;
    process->stdout_fd = (request.stdio_mask & 2U) != 0 ? pipes[1][0] : -1;
    process->stderr_fd = (request.stdio_mask & 4U) != 0 ? pipes[2][0] : -1;
    process->executable_id = request.executable_id;
    process->resource_id = request.resource_id;
    request.executable_id = NULL;
    request.resource_id = NULL;
    close_fd(&pipes[0][0]);
    close_fd(&pipes[1][1]);
    close_fd(&pipes[2][1]);
    if (
        (process->stdin_fd >= 0 && nonblocking(process->stdin_fd) != 0) ||
        (process->stdout_fd >= 0 && nonblocking(process->stdout_fd) != 0) ||
        (process->stderr_fd >= 0 && nonblocking(process->stderr_fd) != 0)
    ) {
        kill(-pid, SIGKILL);
        release_process(process);
        holo_spawn_request_free(&request);
        return holo_write_error(control_fd, frame->request_id, 0, "spawn.io_failed");
    }
    holo_spawn_request_free(&request);
    {
        uint8_t payload[4];
        holo_u32_write(payload, (uint32_t)process->pid);
        return holo_write_frame(
            control_fd,
            HOLO_SPAWNED,
            frame->request_id,
            process->id,
            0,
            payload,
            sizeof(payload)
        );
    }
}

static int queue_stdin(struct holo_process *process, int control_fd, const struct holo_frame *frame) {
    if (process->stdin_fd < 0 || process->input.bytes != NULL || frame->payload_length > 65536U) {
        return holo_write_error(control_fd, frame->request_id, frame->process_id, "stdin.unavailable");
    }
    process->input.bytes = malloc(frame->payload_length == 0 ? 1 : frame->payload_length);
    if (process->input.bytes == NULL) return -1;
    memcpy(process->input.bytes, frame->payload, frame->payload_length);
    process->input.length = frame->payload_length;
    process->input.request_id = frame->request_id;
    if (frame->payload_length == 0) {
        free(process->input.bytes);
        memset(&process->input, 0, sizeof(process->input));
        return holo_write_empty(control_fd, HOLO_ACK, frame->request_id, frame->process_id);
    }
    return 0;
}

int holo_process_command(struct holo_process_table *table, int control_fd, const struct holo_frame *frame) {
    struct holo_process *process = find_process(table, frame->process_id);
    if (process == NULL) return holo_write_error(control_fd, frame->request_id, frame->process_id, "process.not_found");
    if (frame->operation == HOLO_STDIN) return queue_stdin(process, control_fd, frame);
    if (frame->operation == HOLO_STDIN_CLOSE) {
        if (frame->payload_length != 0 || process->input.bytes != NULL) {
            return holo_write_error(control_fd, frame->request_id, frame->process_id, "stdin.busy");
        }
        close_fd(&process->stdin_fd);
        return holo_write_empty(control_fd, HOLO_ACK, frame->request_id, frame->process_id);
    }
    if (frame->operation == HOLO_SIGNAL) {
        struct holo_reader reader = { frame->payload, frame->payload_length, 0 };
        char *name = NULL;
        int signal_value;
        int result;
        if (holo_reader_string(&reader, &name, 32) != 0 || holo_reader_done(&reader) != 0 ||
            (signal_value = holo_signal_value(name)) == 0 || kill(-process->pid, signal_value) != 0) {
            free(name);
            return holo_write_error(control_fd, frame->request_id, frame->process_id, "signal.failed");
        }
        free(name);
        result = holo_write_empty(control_fd, HOLO_ACK, frame->request_id, frame->process_id);
        return result;
    }
    if (frame->operation == HOLO_EXEC_RESPONSE) {
        return holo_exec_gate_response(&process->exec_gate, frame);
    }
    return holo_write_error(control_fd, frame->request_id, frame->process_id, "operation.unsupported");
}
