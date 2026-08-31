#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define HOLO_CAPABILITY_SOCKET "/run/holo/capability.sock"
#define HOLO_MAX_COMMANDS 8
#define HOLO_MAX_TOKEN 4096U
#define HOLO_MAX_RESPONSE (256U * 1024U + 64U)

static void write_u32(uint8_t *output, uint32_t value) {
    output[0] = (uint8_t)(value >> 24U);
    output[1] = (uint8_t)(value >> 16U);
    output[2] = (uint8_t)(value >> 8U);
    output[3] = (uint8_t)value;
}

static uint32_t read_u32(const uint8_t *value) {
    return ((uint32_t)value[0] << 24U) | ((uint32_t)value[1] << 16U) |
        ((uint32_t)value[2] << 8U) | value[3];
}

static int write_all(int fd, const void *bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = write(fd, (const uint8_t *)bytes + offset, length - offset);
        if (count > 0) offset += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else return -1;
    }
    return 0;
}

static int read_all(int fd, void *bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = read(fd, (uint8_t *)bytes + offset, length - offset);
        if (count > 0) offset += (size_t)count;
        else if (count < 0 && errno == EINTR) continue;
        else return -1;
    }
    return 0;
}

static int connect_agent(void) {
    struct sockaddr_un address;
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, HOLO_CAPABILITY_SOCKET, sizeof(HOLO_CAPABILITY_SOCKET));
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int main(int argc, char **argv) {
    uint8_t prefix[4];
    uint8_t *request;
    uint8_t *response;
    size_t length = 4;
    size_t offset = 4;
    uint32_t response_length;
    uint32_t text_length;
    int fd;
    int index;
    if (argc < 3 || argc - 1 > HOLO_MAX_COMMANDS) {
        dprintf(STDERR_FILENO, "usage: hoholo <device|system> <command> [argument]\n");
        return 2;
    }
    for (index = 1; index < argc; index += 1) {
        size_t token_length = strlen(argv[index]);
        if (token_length == 0 || token_length > HOLO_MAX_TOKEN) return 2;
        length += 4 + token_length;
    }
    if (length > 64U * 1024U) return 2;
    request = malloc(length);
    if (request == NULL) return 2;
    request[0] = 1;
    request[1] = (uint8_t)(argc - 1);
    request[2] = 0;
    request[3] = 0;
    for (index = 1; index < argc; index += 1) {
        size_t token_length = strlen(argv[index]);
        write_u32(request + offset, (uint32_t)token_length);
        offset += 4;
        memcpy(request + offset, argv[index], token_length);
        offset += token_length;
    }
    fd = connect_agent();
    write_u32(prefix, (uint32_t)length);
    if (fd < 0 || write_all(fd, prefix, sizeof(prefix)) != 0 || write_all(fd, request, length) != 0 ||
        read_all(fd, prefix, sizeof(prefix)) != 0) {
        free(request);
        if (fd >= 0) close(fd);
        dprintf(STDERR_FILENO, "hoholo: bridge unavailable\n");
        return 1;
    }
    free(request);
    response_length = read_u32(prefix);
    if (response_length < 8 || response_length > HOLO_MAX_RESPONSE) {
        close(fd);
        return 1;
    }
    response = malloc(response_length);
    if (response == NULL || read_all(fd, response, response_length) != 0) {
        free(response);
        close(fd);
        return 1;
    }
    close(fd);
    if (response[0] != 1 || response[1] > 1 || response[2] != 0 || response[3] != 0) {
        free(response);
        return 1;
    }
    text_length = read_u32(response + 4);
    if (text_length != response_length - 8 || memchr(response + 8, 0, text_length) != NULL) {
        free(response);
        return 1;
    }
    if (write_all(response[1] == 1 ? STDOUT_FILENO : STDERR_FILENO, response + 8, text_length) != 0 ||
        write_all(response[1] == 1 ? STDOUT_FILENO : STDERR_FILENO, "\n", 1) != 0) {
        free(response);
        return 1;
    }
    index = response[1] == 1 ? 0 : 1;
    free(response);
    return index;
}
