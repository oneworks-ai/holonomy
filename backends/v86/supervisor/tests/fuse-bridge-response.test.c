#include "../fuse-bridge.h"

#include <assert.h>
#include <errno.h>
#include <linux/fuse.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/types.h>

static int write_errno;
static int writes;
static int short_write;
static int frames;

ssize_t holo_test_read(int fd, void *bytes, size_t length) {
    const struct fuse_in_header interrupt = {
        .len = sizeof(interrupt),
        .opcode = FUSE_INTERRUPT,
        .unique = 43,
        .pid = 0
    };
    (void)fd;
    assert(length >= sizeof(interrupt));
    memcpy(bytes, &interrupt, sizeof(interrupt));
    return sizeof(interrupt);
}

ssize_t holo_test_write(int fd, const void *bytes, size_t length) {
    (void)fd;
    (void)bytes;
    writes += 1;
    if (write_errno != 0) {
        errno = write_errno;
        return -1;
    }
    return short_write ? (ssize_t)length - 1 : (ssize_t)length;
}

int mount(const char *source, const char *target, const char *type, unsigned long flags, const void *data) {
    (void)source;
    (void)target;
    (void)type;
    (void)flags;
    (void)data;
    return 0;
}

int umount2(const char *target, int flags) {
    (void)target;
    (void)flags;
    return 0;
}

uint32_t holo_process_id_for_guest_pid(struct holo_process_table *table, pid_t pid) {
    (void)table;
    (void)pid;
    return 0;
}

int holo_write_frame(int fd, uint8_t operation, uint32_t request_id, uint32_t process_id,
                     uint32_t sequence, const void *payload, uint32_t payload_length) {
    (void)fd;
    assert(operation == HOLO_FILESYSTEM_REQUEST);
    assert(request_id == 1);
    assert(process_id == 0);
    (void)sequence;
    (void)payload;
    assert(payload_length == sizeof(struct fuse_in_header));
    frames += 1;
    return 0;
}

static void interrupt_round_trip(void) {
    struct holo_fuse_bridge bridge = { .fd = 11, .next_request_id = 1 };
    struct holo_process_table processes = { 0 };
    struct pollfd poll_fd = { .fd = 11, .events = POLLIN, .revents = POLLIN };
    struct fuse_out_header output = { sizeof(output), -EACCES, 43 };
    struct holo_frame reply = {
        .operation = HOLO_FILESYSTEM_RESPONSE,
        .process_id = 0,
        .request_id = 1,
        .payload = (uint8_t *)&output,
        .payload_length = sizeof(output)
    };
    frames = 0;
    writes = 0;
    write_errno = ENOENT;
    assert(holo_fuse_bridge_poll(&bridge, &processes, 12, &poll_fd) == 0);
    assert(frames == 1);
    assert(bridge.pending[0].used == 1);
    assert(bridge.pending[0].opcode == FUSE_INTERRUPT);
    assert(holo_fuse_bridge_response(&bridge, &reply) == 0);
    assert(writes == 1);
    assert(bridge.pending[0].used == 0);
}

static int reply(uint32_t opcode, uint64_t pending_unique, uint64_t reply_unique) {
    struct holo_fuse_bridge bridge;
    struct fuse_out_header output = { sizeof(output), -EACCES, reply_unique };
    struct holo_frame frame = {
        .operation = HOLO_FILESYSTEM_RESPONSE,
        .process_id = 7,
        .request_id = 9,
        .payload = (uint8_t *)&output,
        .payload_length = sizeof(output)
    };
    int result;
    memset(&bridge, 0, sizeof(bridge));
    bridge.fd = 11;
    bridge.pending[0] = (struct holo_fuse_pending){ 1, 7, 9, pending_unique, opcode };
    writes = 0;
    result = holo_fuse_bridge_response(&bridge, &frame);
    if (pending_unique == reply_unique) {
        assert(bridge.pending[0].used == 0);
        assert(writes == 1);
    } else {
        assert(bridge.pending[0].used == 1);
        assert(writes == 0);
    }
    return result;
}

int main(void) {
    interrupt_round_trip();
    write_errno = ENOENT;
    assert(reply(FUSE_INTERRUPT, 43, 43) == 0);
    assert(reply(FUSE_INTERRUPT, 43, 44) == -1);
    assert(reply(FUSE_INIT, 43, 43) == -1);
    write_errno = EIO;
    assert(reply(FUSE_INTERRUPT, 43, 43) == -1);
    write_errno = 0;
    short_write = 1;
    assert(reply(FUSE_INTERRUPT, 43, 43) == -1);
    short_write = 0;
    assert(reply(FUSE_INTERRUPT, 43, 43) == 0);
    return 0;
}
