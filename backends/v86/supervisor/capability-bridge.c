#include "capability-bridge.h"

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define HOLO_CAPABILITY_SOCKET "/run/holo/capability.sock"

static uint32_t read_u32(const uint8_t *value) {
    return ((uint32_t)value[0] << 24U) | ((uint32_t)value[1] << 16U) |
        ((uint32_t)value[2] << 8U) | value[3];
}

static void close_client(struct holo_capability_client *client) {
    if (client->fd >= 0) close(client->fd);
    free(client->request);
    free(client->response);
    memset(client, 0, sizeof(*client));
    client->fd = -1;
}

static struct holo_capability_client *allocate_client(struct holo_capability_bridge *bridge) {
    size_t index;
    for (index = 0; index < HOLO_CAPABILITY_MAX_CLIENTS; index += 1) {
        if (!bridge->clients[index].used) return &bridge->clients[index];
    }
    return NULL;
}

static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0 ? -1 : 0;
}

int holo_capability_bridge_init(struct holo_capability_bridge *bridge) {
    struct sockaddr_un address;
    size_t index;
    memset(bridge, 0, sizeof(*bridge));
    bridge->listen_fd = -1;
    bridge->next_request_id = 1;
    for (index = 0; index < HOLO_CAPABILITY_MAX_CLIENTS; index += 1) bridge->clients[index].fd = -1;
    mkdir("/run", 0755);
    mkdir("/run/holo", 0755);
    bridge->listen_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (bridge->listen_fd < 0 || nonblocking(bridge->listen_fd) != 0) goto fail;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, HOLO_CAPABILITY_SOCKET, sizeof(HOLO_CAPABILITY_SOCKET));
    unlink(HOLO_CAPABILITY_SOCKET);
    if (
        bind(bridge->listen_fd, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        chown(HOLO_CAPABILITY_SOCKET, 1000, 1000) != 0 || chmod(HOLO_CAPABILITY_SOCKET, 0600) != 0 ||
        listen(bridge->listen_fd, (int)HOLO_CAPABILITY_MAX_CLIENTS) != 0
    ) goto fail;
    return 0;
fail:
    holo_capability_bridge_close(bridge);
    return -1;
}

void holo_capability_bridge_close(struct holo_capability_bridge *bridge) {
    size_t index;
    if (bridge->listen_fd >= 0) close(bridge->listen_fd);
    bridge->listen_fd = -1;
    for (index = 0; index < HOLO_CAPABILITY_MAX_CLIENTS; index += 1) {
        if (bridge->clients[index].used) close_client(&bridge->clients[index]);
    }
    unlink(HOLO_CAPABILITY_SOCKET);
}

size_t holo_capability_bridge_poll_fds(struct holo_capability_bridge *bridge, struct pollfd *fds,
                                       struct holo_capability_poll_target *targets, size_t offset) {
    size_t index;
    if (bridge->listen_fd >= 0) {
        fds[offset] = (struct pollfd){ bridge->listen_fd, POLLIN, 0 };
        targets[offset++] = (struct holo_capability_poll_target){ 1, NULL };
    }
    for (index = 0; index < HOLO_CAPABILITY_MAX_CLIENTS; index += 1) {
        struct holo_capability_client *client = &bridge->clients[index];
        if (!client->used || client->fd < 0) continue;
        fds[offset] = (struct pollfd){
            client->fd,
            client->response == NULL ? POLLIN : POLLOUT,
            0
        };
        targets[offset++] = (struct holo_capability_poll_target){ 0, client };
    }
    return offset;
}

static int accept_client(struct holo_capability_bridge *bridge) {
    struct holo_capability_client *client;
    struct ucred credentials;
    socklen_t length = sizeof(credentials);
    int fd = accept4(bridge->listen_fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0) return errno == EAGAIN || errno == EINTR ? 0 : -1;
    client = allocate_client(bridge);
    if (client == NULL || getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 ||
        credentials.uid != 1000 || credentials.pid <= 1) {
        close(fd);
        return 0;
    }
    *client = (struct holo_capability_client){ .used = 1, .fd = fd, .pid = credentials.pid };
    return 0;
}

static int dispatch_request(struct holo_capability_bridge *bridge, struct holo_process_table *processes,
                            int control_fd, struct holo_capability_client *client) {
    uint32_t request_id = bridge->next_request_id++;
    if (request_id == 0) request_id = bridge->next_request_id++;
    client->process_id = holo_process_id_for_guest_pid(processes, client->pid);
    if (client->process_id == 0) return -1;
    client->request_id = request_id;
    client->waiting = 1;
    return holo_write_frame(
        control_fd,
        HOLO_CAPABILITY_REQUEST,
        request_id,
        client->process_id,
        (uint32_t)client->pid,
        client->request,
        (uint32_t)client->request_length
    );
}

static int read_client(struct holo_capability_bridge *bridge, struct holo_process_table *processes,
                       int control_fd, struct holo_capability_client *client) {
    ssize_t count;
    if (client->waiting) {
        uint8_t byte;
        count = recv(client->fd, &byte, 1, MSG_PEEK);
        if (count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR)) close_client(client);
        return 0;
    }
    if (client->prefix_offset < sizeof(client->prefix)) {
        count = read(client->fd, client->prefix + client->prefix_offset, sizeof(client->prefix) - client->prefix_offset);
        if (count > 0) client->prefix_offset += (size_t)count;
        else if (count == 0) close_client(client);
        else if (errno != EAGAIN && errno != EINTR) close_client(client);
        if (!client->used || client->prefix_offset < sizeof(client->prefix)) return 0;
        client->request_length = read_u32(client->prefix);
        if (client->request_length < 4 || client->request_length > 64U * 1024U) {
            close_client(client);
            return 0;
        }
        client->request = malloc(client->request_length);
        if (client->request == NULL) return -1;
    }
    count = read(client->fd, client->request + client->request_offset, client->request_length - client->request_offset);
    if (count > 0) client->request_offset += (size_t)count;
    else if (count == 0) close_client(client);
    else if (errno != EAGAIN && errno != EINTR) close_client(client);
    if (!client->used || client->request_offset < client->request_length) return 0;
    if (dispatch_request(bridge, processes, control_fd, client) != 0) {
        close_client(client);
    }
    return 0;
}

static int write_client(struct holo_capability_client *client) {
    ssize_t count = write(
        client->fd,
        client->response + client->response_offset,
        client->response_length - client->response_offset
    );
    if (count > 0) client->response_offset += (size_t)count;
    else if (count == 0 || (errno != EAGAIN && errno != EINTR)) close_client(client);
    if (client->used && client->response_offset == client->response_length) close_client(client);
    return 0;
}

int holo_capability_bridge_poll_event(struct holo_capability_bridge *bridge, struct holo_process_table *processes,
                                      int control_fd, const struct pollfd *fd,
                                      const struct holo_capability_poll_target *target) {
    if (fd->revents == 0) return 0;
    if (target->listener) return accept_client(bridge);
    if (target->client == NULL || !target->client->used) return 0;
    if ((fd->revents & (POLLERR | POLLHUP)) != 0) {
        close_client(target->client);
        return 0;
    }
    return target->client->response == NULL
        ? read_client(bridge, processes, control_fd, target->client)
        : write_client(target->client);
}

int holo_capability_bridge_response(struct holo_capability_bridge *bridge, const struct holo_frame *frame) {
    size_t index;
    if (frame->payload_length < 8 || frame->payload_length > HOLO_CAPABILITY_MAX_PAYLOAD) return -1;
    for (index = 0; index < HOLO_CAPABILITY_MAX_CLIENTS; index += 1) {
        struct holo_capability_client *client = &bridge->clients[index];
        if (
            !client->used || !client->waiting || client->request_id != frame->request_id ||
            client->process_id != frame->process_id
        ) continue;
        client->response_length = 4U + frame->payload_length;
        client->response = malloc(client->response_length);
        if (client->response == NULL) return -1;
        holo_u32_write(client->response, frame->payload_length);
        memcpy(client->response + 4, frame->payload, frame->payload_length);
        client->waiting = 0;
        return 0;
    }
    return 0;
}
