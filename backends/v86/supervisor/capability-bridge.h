#ifndef HOLO_SUPERVISOR_CAPABILITY_BRIDGE_H
#define HOLO_SUPERVISOR_CAPABILITY_BRIDGE_H

#include "process.h"

#include <poll.h>
#include <stddef.h>
#include <stdint.h>

#define HOLO_CAPABILITY_MAX_CLIENTS 16U
#define HOLO_CAPABILITY_MAX_PAYLOAD (256U * 1024U + 64U)

struct holo_capability_client {
    int used;
    int fd;
    pid_t pid;
    uint32_t process_id;
    uint32_t request_id;
    uint8_t prefix[4];
    size_t prefix_offset;
    uint8_t *request;
    size_t request_length;
    size_t request_offset;
    uint8_t *response;
    size_t response_length;
    size_t response_offset;
    int waiting;
};

struct holo_capability_bridge {
    int listen_fd;
    uint32_t next_request_id;
    struct holo_capability_client clients[HOLO_CAPABILITY_MAX_CLIENTS];
};

struct holo_capability_poll_target {
    int listener;
    struct holo_capability_client *client;
};

int holo_capability_bridge_init(struct holo_capability_bridge *bridge);
void holo_capability_bridge_close(struct holo_capability_bridge *bridge);
size_t holo_capability_bridge_poll_fds(
    struct holo_capability_bridge *bridge,
    struct pollfd *fds,
    struct holo_capability_poll_target *targets,
    size_t offset
);
int holo_capability_bridge_poll_event(
    struct holo_capability_bridge *bridge,
    struct holo_process_table *processes,
    int control_fd,
    const struct pollfd *fd,
    const struct holo_capability_poll_target *target
);
int holo_capability_bridge_response(
    struct holo_capability_bridge *bridge,
    const struct holo_frame *frame
);

#endif
