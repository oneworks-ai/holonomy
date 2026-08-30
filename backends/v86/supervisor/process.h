#ifndef HOLO_SUPERVISOR_PROCESS_H
#define HOLO_SUPERVISOR_PROCESS_H

#include "protocol.h"
#include "exec-gate.h"

#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define HOLO_MAX_PROCESSES 32

enum holo_poll_stream {
    HOLO_POLL_STDIN,
    HOLO_POLL_STDOUT,
    HOLO_POLL_STDERR,
    HOLO_POLL_EXEC
};

struct holo_pending_write {
    uint8_t *bytes;
    size_t length;
    size_t offset;
    uint32_t request_id;
};

struct holo_process {
    int used;
    uint32_t id;
    pid_t pid;
    int stdin_fd;
    int stdout_fd;
    int stderr_fd;
    uint32_t stdout_sequence;
    uint32_t stderr_sequence;
    int exited;
    int exit_code;
    int exit_signal;
    struct holo_pending_write input;
    struct holo_exec_gate exec_gate;
    char *executable_id;
    char *resource_id;
};

struct holo_process_table {
    struct holo_process entries[HOLO_MAX_PROCESSES];
    uint32_t next_id;
    uint32_t next_exec_request_id;
};

struct holo_poll_target {
    struct holo_process *process;
    enum holo_poll_stream stream;
};

void holo_process_table_init(struct holo_process_table *table);
int holo_process_spawn(struct holo_process_table *table, int control_fd, const struct holo_frame *frame);
int holo_process_command(struct holo_process_table *table, int control_fd, const struct holo_frame *frame);
uint32_t holo_process_id_for_guest_pid(struct holo_process_table *table, pid_t pid);
size_t holo_process_poll_fds(
    struct holo_process_table *table,
    struct pollfd *fds,
    struct holo_poll_target *targets,
    size_t offset
);
int holo_process_poll_event(int control_fd, const struct pollfd *fd, const struct holo_poll_target *target);
int holo_process_exec_poll_event(
    struct holo_process_table *table,
    int control_fd,
    const struct pollfd *fd,
    const struct holo_poll_target *target,
    uint32_t timeout_ms
);
int holo_process_reap(struct holo_process_table *table, int control_fd);
int holo_process_exec_timeouts(struct holo_process_table *table);
void holo_process_shutdown(struct holo_process_table *table);

#endif
