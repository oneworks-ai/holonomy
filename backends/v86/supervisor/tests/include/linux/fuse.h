#ifndef HOLO_TEST_LINUX_FUSE_H
#define HOLO_TEST_LINUX_FUSE_H

#include <stdint.h>

#define FUSE_INIT 26
#define FUSE_FORGET 2
#define FUSE_BATCH_FORGET 42
#define FUSE_DESTROY 38
#define FUSE_INTERRUPT 36
#define FUSE_ATOMIC_O_TRUNC (1U << 3)

struct fuse_in_header {
    uint32_t len;
    uint32_t opcode;
    uint64_t unique;
    uint64_t nodeid;
    uint32_t uid;
    uint32_t gid;
    uint32_t pid;
    uint32_t padding;
};

struct fuse_out_header {
    uint32_t len;
    int32_t error;
    uint64_t unique;
};

struct fuse_init_in {
    uint32_t major;
    uint32_t minor;
};

struct fuse_init_out {
    uint32_t major;
    uint32_t minor;
    uint32_t max_readahead;
    uint32_t flags;
    uint16_t max_background;
    uint16_t congestion_threshold;
    uint32_t max_write;
    uint32_t time_gran;
    uint16_t max_pages;
};

#endif
