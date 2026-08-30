#include "process.h"

#include <signal.h>
#include <stdlib.h>
#include <string.h>

int holo_write_error(int fd, uint32_t request_id, uint32_t process_id, const char *code) {
    size_t length = strlen(code);
    uint8_t *payload;
    int result;
    if (length > 63) return -1;
    payload = malloc(4 + length);
    if (payload == NULL) return -1;
    holo_u32_write(payload, (uint32_t)length);
    memcpy(payload + 4, code, length);
    result = holo_write_frame(fd, HOLO_ERROR, request_id, process_id, 0, payload, (uint32_t)(4 + length));
    free(payload);
    return result;
}

const char *holo_signal_name(int signal_value) {
    switch (signal_value) {
        case SIGHUP: return "SIGHUP";
        case SIGINT: return "SIGINT";
        case SIGQUIT: return "SIGQUIT";
        case SIGKILL: return "SIGKILL";
        case SIGTERM: return "SIGTERM";
        case SIGUSR1: return "SIGUSR1";
        case SIGUSR2: return "SIGUSR2";
        default: return "SIGUNKNOWN";
    }
}

int holo_signal_value(const char *name) {
    if (strcmp(name, "SIGHUP") == 0) return SIGHUP;
    if (strcmp(name, "SIGINT") == 0) return SIGINT;
    if (strcmp(name, "SIGQUIT") == 0) return SIGQUIT;
    if (strcmp(name, "SIGKILL") == 0) return SIGKILL;
    if (strcmp(name, "SIGTERM") == 0) return SIGTERM;
    if (strcmp(name, "SIGUSR1") == 0) return SIGUSR1;
    if (strcmp(name, "SIGUSR2") == 0) return SIGUSR2;
    return 0;
}

int holo_write_completion(int fd, uint8_t operation, uint32_t process_id, int code, int signal_value) {
    const char *signal_name = signal_value == 0 ? "" : holo_signal_name(signal_value);
    size_t signal_length = strlen(signal_name);
    uint8_t payload[4 + 4 + 16];
    holo_u32_write(payload, code < 0 ? UINT32_MAX : (uint32_t)code);
    holo_u32_write(payload + 4, (uint32_t)signal_length);
    memcpy(payload + 8, signal_name, signal_length);
    return holo_write_frame(
        fd,
        operation,
        0,
        process_id,
        0,
        payload,
        (uint32_t)(8 + signal_length)
    );
}
