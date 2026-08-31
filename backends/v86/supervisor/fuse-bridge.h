#ifndef HOLO_SUPERVISOR_FUSE_BRIDGE_H
#define HOLO_SUPERVISOR_FUSE_BRIDGE_H

#include "process.h"

#include <poll.h>
#include <stdint.h>

#define HOLO_FUSE_MAX_PENDING 64

struct holo_fuse_pending {
    int used;
    uint32_t process_id;
    uint32_t request_id;
    uint64_t unique;
};

struct holo_fuse_bridge {
    int fd;
    uint32_t next_request_id;
    struct holo_fuse_pending pending[HOLO_FUSE_MAX_PENDING];
};

void holo_fuse_bridge_close(struct holo_fuse_bridge *bridge);
int holo_fuse_bridge_init(struct holo_fuse_bridge *bridge);
int holo_fuse_bridge_poll(
    struct holo_fuse_bridge *bridge,
    struct holo_process_table *processes,
    int control_fd,
    const struct pollfd *poll_fd
);
int holo_fuse_bridge_response(struct holo_fuse_bridge *bridge, const struct holo_frame *frame);

#endif
