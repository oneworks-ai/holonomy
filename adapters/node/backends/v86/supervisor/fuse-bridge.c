#include "fuse-bridge.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define HOLO_FUSE_BUFFER_BYTES (128U * 1024U)

static struct holo_fuse_pending *allocate_pending(struct holo_fuse_bridge *bridge) {
    size_t index;
    for (index = 0; index < HOLO_FUSE_MAX_PENDING; index += 1) {
        if (!bridge->pending[index].used) return &bridge->pending[index];
    }
    return NULL;
}

static struct holo_fuse_pending *find_pending(struct holo_fuse_bridge *bridge, uint32_t request_id) {
    size_t index;
    for (index = 0; index < HOLO_FUSE_MAX_PENDING; index += 1) {
        if (bridge->pending[index].used && bridge->pending[index].request_id == request_id) {
            return &bridge->pending[index];
        }
    }
    return NULL;
}

static int write_error(int fd, uint64_t unique, int error) {
    struct fuse_out_header output = { sizeof(output), -error, unique };
    return write(fd, &output, sizeof(output)) == (ssize_t)sizeof(output) ? 0 : -1;
}

int holo_fuse_bridge_init(struct holo_fuse_bridge *bridge) {
    char options[128];
    memset(bridge, 0, sizeof(*bridge));
    bridge->fd = -1;
    bridge->next_request_id = 1;
    mkdir("/workspace", 0755);
    bridge->fd = open("/dev/fuse", O_CLOEXEC | O_RDWR);
    if (bridge->fd < 0) return -1;
    snprintf(
        options,
        sizeof(options),
        "fd=%d,rootmode=40000,user_id=0,group_id=0,max_read=65536",
        bridge->fd
    );
    if (mount("holo-fs", "/workspace", "fuse", MS_NODEV | MS_NOSUID, options) != 0) {
        close(bridge->fd);
        bridge->fd = -1;
        return -1;
    }
    return 0;
}

void holo_fuse_bridge_close(struct holo_fuse_bridge *bridge) {
    if (bridge->fd < 0) return;
    umount2("/workspace", MNT_DETACH);
    close(bridge->fd);
    bridge->fd = -1;
    memset(bridge->pending, 0, sizeof(bridge->pending));
}

int holo_fuse_bridge_poll(struct holo_fuse_bridge *bridge, struct holo_process_table *processes,
                          int control_fd, const struct pollfd *poll_fd) {
    uint8_t *bytes;
    struct fuse_in_header *input;
    struct holo_fuse_pending *pending;
    ssize_t count;
    uint32_t request_id;
    uint32_t process_id;
    if (bridge->fd < 0 || (poll_fd->revents & (POLLIN | POLLERR | POLLHUP)) == 0) return 0;
    bytes = malloc(HOLO_FUSE_BUFFER_BYTES);
    if (bytes == NULL) return -1;
    count = read(bridge->fd, bytes, HOLO_FUSE_BUFFER_BYTES);
    if (count < (ssize_t)sizeof(*input)) {
        free(bytes);
        return count < 0 && errno == EINTR ? 0 : -1;
    }
    input = (struct fuse_in_header *)bytes;
    if (input->len != (uint32_t)count || input->unique == 0) {
        free(bytes);
        return -1;
    }
    if (input->opcode == FUSE_FORGET || input->opcode == FUSE_BATCH_FORGET || input->opcode == FUSE_DESTROY) {
        free(bytes);
        return 0;
    }
    pending = allocate_pending(bridge);
    if (pending == NULL) {
        int result = write_error(bridge->fd, input->unique, EAGAIN);
        free(bytes);
        return result;
    }
    request_id = bridge->next_request_id++;
    if (request_id == 0) request_id = bridge->next_request_id++;
    process_id = holo_process_id_for_guest_pid(processes, (pid_t)input->pid);
    *pending = (struct holo_fuse_pending){ 1, process_id, request_id, input->unique };
    if (holo_write_frame(
        control_fd,
        HOLO_FILESYSTEM_REQUEST,
        request_id,
        process_id,
        0,
        bytes,
        (uint32_t)count
    ) != 0) {
        memset(pending, 0, sizeof(*pending));
        free(bytes);
        return -1;
    }
    free(bytes);
    return 0;
}

int holo_fuse_bridge_response(struct holo_fuse_bridge *bridge, const struct holo_frame *frame) {
    struct holo_fuse_pending *pending = find_pending(bridge, frame->request_id);
    const struct fuse_out_header *output;
    if (pending == NULL || pending->process_id != frame->process_id ||
        frame->payload_length < sizeof(*output)) return -1;
    output = (const struct fuse_out_header *)frame->payload;
    if (output->len != frame->payload_length || output->unique != pending->unique) return -1;
    memset(pending, 0, sizeof(*pending));
    return write(bridge->fd, frame->payload, frame->payload_length) == (ssize_t)frame->payload_length ? 0 : -1;
}
