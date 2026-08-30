#include "configuration.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define HOLO_MAX_HOSTS 256U
#define HOLO_MAX_HOSTNAME 253U

static int valid_ipv4(const char *value) {
    unsigned int a;
    unsigned int b;
    unsigned int c;
    unsigned int d;
    char tail;
    return sscanf(value, "%u.%u.%u.%u%c", &a, &b, &c, &d, &tail) == 4 &&
        a <= 255U && b <= 255U && c <= 255U && d <= 255U;
}

static int valid_hostname(const char *value) {
    size_t index;
    size_t label = 0;
    size_t length = strlen(value);
    if (length == 0 || length > HOLO_MAX_HOSTNAME) return 0;
    for (index = 0; index < length; index += 1) {
        unsigned char byte = (unsigned char)value[index];
        if (byte == '.') {
            if (label == 0 || label > 63 || value[index - 1] == '-') return 0;
            label = 0;
        } else {
            if (!((byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9') ||
                  (byte == '-' && label > 0))) return 0;
            label += 1;
        }
    }
    return label > 0 && label <= 63 && value[length - 1] != '-';
}

static int write_all(int fd, const char *bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = write(fd, bytes + offset, length - offset);
        if (count > 0) offset += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else return -1;
    }
    return 0;
}

int holo_configuration_apply(int control_fd, const struct holo_frame *frame, uint32_t *exec_gate_timeout_ms) {
    struct holo_reader reader = { frame->payload, frame->payload_length, 0 };
    uint8_t version;
    uint8_t flags;
    uint16_t count;
    uint16_t index;
    uint8_t timeout_bytes[4];
    uint32_t timeout;
    int fd = -1;
    int result = -1;
    if (
        frame->process_id != 0 || frame->request_id == 0 || frame->sequence != 0 ||
        holo_reader_u8(&reader, &version) != 0 || version != 1 ||
        holo_reader_u8(&reader, &flags) != 0 || flags != 0 ||
        holo_reader_u16(&reader, &count) != 0 || count > HOLO_MAX_HOSTS ||
        holo_reader_bytes(&reader, timeout_bytes, sizeof(timeout_bytes)) != 0
    ) return -1;
    timeout = ((uint32_t)timeout_bytes[0] << 24U) | ((uint32_t)timeout_bytes[1] << 16U) |
        ((uint32_t)timeout_bytes[2] << 8U) | timeout_bytes[3];
    if (timeout < 1 || timeout > 120000U) return -1;
    fd = open("/etc/.hosts.holo.tmp", O_CLOEXEC | O_CREAT | O_EXCL | O_WRONLY, 0644);
    if (fd < 0) return -1;
    if (write_all(fd, "127.0.0.1 localhost\n", 20) != 0) goto done;
    for (index = 0; index < count; index += 1) {
        char *address = NULL;
        char *hostname = NULL;
        if (
            holo_reader_string(&reader, &address, 15) != 0 ||
            holo_reader_string(&reader, &hostname, HOLO_MAX_HOSTNAME) != 0 ||
            !valid_ipv4(address) || !valid_hostname(hostname) ||
            dprintf(fd, "%s %s\n", address, hostname) < 0
        ) {
            free(address);
            free(hostname);
            goto done;
        }
        free(address);
        free(hostname);
    }
    if (holo_reader_done(&reader) != 0 || fsync(fd) != 0 || close(fd) != 0) {
        fd = -1;
        goto done;
    }
    fd = -1;
    if (rename("/etc/.hosts.holo.tmp", "/etc/hosts") != 0) goto done;
    result = holo_write_empty(control_fd, HOLO_ACK, frame->request_id, 0);
    if (result == 0) *exec_gate_timeout_ms = timeout;
done:
    if (fd >= 0) close(fd);
    if (result != 0) unlink("/etc/.hosts.holo.tmp");
    return result;
}
