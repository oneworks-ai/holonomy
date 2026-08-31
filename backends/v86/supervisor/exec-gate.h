#ifndef HOLO_SUPERVISOR_EXEC_GATE_H
#define HOLO_SUPERVISOR_EXEC_GATE_H

#include "protocol.h"

#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

struct holo_exec_gate {
    int listener_fd;
    pid_t initial_pid;
    uint64_t notification_id;
    uint32_t request_id;
    pid_t notification_pid;
    uintptr_t path_address;
    uintptr_t argv_address;
    uint8_t *snapshot;
    size_t snapshot_length;
    int pending;
    int pending_kind;
    int64_t deadline_ms;
    int commit_pending;
    uint32_t commit_request_id;
    pid_t commit_pid;
    uint64_t commit_process_start_time_ticks;
    uint64_t commit_target_device;
    uint64_t commit_target_inode;
    char *commit_target_path;
    int64_t commit_deadline_ms;
};

void holo_exec_gate_init(struct holo_exec_gate *gate);
int holo_exec_gate_prepare_child(int socket_fd);
int holo_exec_gate_prepare_parent(int socket_fd, pid_t root_pid, struct holo_exec_gate *gate);
int holo_exec_gate_poll_event(
    struct holo_exec_gate *gate,
    int control_fd,
    uint32_t process_id,
    uint32_t request_id,
    uint32_t timeout_ms
);
int holo_exec_gate_response(struct holo_exec_gate *gate, int control_fd, const struct holo_frame *frame);
int holo_network_gate_response(struct holo_exec_gate *gate, const struct holo_frame *frame);
int holo_exec_gate_progress(
    struct holo_exec_gate *gate,
    int control_fd,
    uint32_t process_id
);
void holo_exec_gate_close(struct holo_exec_gate *gate);

#endif
