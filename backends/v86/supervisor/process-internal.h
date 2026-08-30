#ifndef HOLO_SUPERVISOR_PROCESS_INTERNAL_H
#define HOLO_SUPERVISOR_PROCESS_INTERNAL_H

#include "process.h"

struct holo_spawn_request {
    char *path;
    char *cwd;
    char *executable_id;
    char *resource_id;
    char **argv;
    char **envp;
    uint8_t stdio_mask;
};

int holo_parse_spawn(const struct holo_frame *frame, struct holo_spawn_request *request);
void holo_spawn_request_free(struct holo_spawn_request *request);
int holo_signal_value(const char *name);
int holo_write_completion(int fd, uint8_t operation, uint32_t process_id, int code, int signal_value);
int holo_write_error(int fd, uint32_t request_id, uint32_t process_id, const char *code);

#endif
