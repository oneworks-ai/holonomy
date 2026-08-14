#ifndef HOLO_SUPERVISOR_PROTOCOL_H
#define HOLO_SUPERVISOR_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define HOLO_MAX_FRAME_BYTES (1024U * 1024U)
#define HOLO_HEADER_BYTES 20U
#define HOLO_KERNEL_PROCESS (1U << 0)
#define HOLO_KERNEL_FUSE (1U << 1)
#define HOLO_KERNEL_TUN (1U << 2)
#define HOLO_KERNEL_NETWORK_NAMESPACES (1U << 3)
#define HOLO_KERNEL_CGROUPS (1U << 4)
#define HOLO_KERNEL_FANOTIFY (1U << 5)
#define HOLO_KERNEL_SECCOMP_USER_NOTIFICATION (1U << 6)

enum holo_operation {
    HOLO_ACK = 1,
    HOLO_CLOSE = 2,
    HOLO_ERROR = 3,
    HOLO_EXIT = 4,
    HOLO_READY = 5,
    HOLO_SHUTDOWN = 6,
    HOLO_SIGNAL = 7,
    HOLO_SPAWN = 8,
    HOLO_SPAWNED = 9,
    HOLO_STDERR = 10,
    HOLO_STDIN = 11,
    HOLO_STDIN_CLOSE = 12,
    HOLO_STDOUT = 13,
    HOLO_FILESYSTEM_REQUEST = 14,
    HOLO_FILESYSTEM_RESPONSE = 15
};

struct holo_frame {
    uint8_t operation;
    uint32_t process_id;
    uint32_t request_id;
    uint32_t sequence;
    uint8_t *payload;
    uint32_t payload_length;
};

struct holo_reader {
    const uint8_t *bytes;
    size_t length;
    size_t offset;
};

void holo_frame_free(struct holo_frame *frame);
int holo_read_frame(int fd, struct holo_frame *frame);
int holo_write_frame(
    int fd,
    uint8_t operation,
    uint32_t request_id,
    uint32_t process_id,
    uint32_t sequence,
    const void *payload,
    uint32_t payload_length
);
int holo_write_empty(int fd, uint8_t operation, uint32_t request_id, uint32_t process_id);

int holo_reader_bytes(struct holo_reader *reader, void *output, size_t length);
int holo_reader_string(struct holo_reader *reader, char **output, uint32_t maximum);
int holo_reader_u16(struct holo_reader *reader, uint16_t *output);
int holo_reader_u8(struct holo_reader *reader, uint8_t *output);
int holo_reader_done(const struct holo_reader *reader);

void holo_u32_write(uint8_t *output, uint32_t value);

#endif
