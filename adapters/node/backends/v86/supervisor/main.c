#include "process.h"
#include "protocol.h"
#include "fuse-bridge.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/fanotify.h>
#include <sys/syscall.h>
#include <linux/seccomp.h>
#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>

#define HOLO_MAX_POLL_FDS (2 + HOLO_MAX_PROCESSES * 3)

static int file_contains(const char *path, const char *needle) {
    char bytes[4096];
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    ssize_t count;
    if (fd < 0) return 0;
    count = read(fd, bytes, sizeof(bytes) - 1);
    close(fd);
    if (count <= 0) return 0;
    bytes[count] = '\0';
    return strstr(bytes, needle) != NULL;
}

static int is_character_device(const char *path) {
    struct stat value;
    return stat(path, &value) == 0 && S_ISCHR(value.st_mode);
}

static int supports_fanotify(void) {
    int fd = fanotify_init(FAN_CLASS_CONTENT | FAN_CLOEXEC | FAN_NONBLOCK, O_RDONLY | O_LARGEFILE);
    if (fd < 0) return 0;
    close(fd);
    return 1;
}

static int supports_seccomp_user_notification(void) {
    uint32_t action = SECCOMP_RET_USER_NOTIF;
    return syscall(SYS_seccomp, SECCOMP_GET_ACTION_AVAIL, 0, &action) == 0;
}

static int write_ready(int fd, int fuse_available) {
    uint32_t flags = HOLO_KERNEL_PROCESS;
    uint8_t payload[4];
    if (fuse_available && is_character_device("/dev/fuse") && file_contains("/proc/filesystems", "fuse")) {
        flags |= HOLO_KERNEL_FUSE;
    }
    if (is_character_device("/dev/net/tun")) flags |= HOLO_KERNEL_TUN;
    if (access("/proc/self/ns/net", R_OK) == 0) flags |= HOLO_KERNEL_NETWORK_NAMESPACES;
    if (file_contains("/proc/filesystems", "cgroup")) flags |= HOLO_KERNEL_CGROUPS;
    if (supports_fanotify()) flags |= HOLO_KERNEL_FANOTIFY;
    if (supports_seccomp_user_notification()) flags |= HOLO_KERNEL_SECCOMP_USER_NOTIFICATION;
    holo_u32_write(payload, flags);
    return holo_write_frame(fd, HOLO_READY, 0, 0, 0, payload, sizeof(payload));
}

static int open_control(void) {
    struct termios attributes;
    int attempt;
    int fd = -1;
    for (attempt = 0; attempt < 100 && fd < 0; attempt += 1) {
        fd = open("/dev/ttyS1", O_CLOEXEC | O_RDWR | O_NOCTTY);
        if (fd < 0) usleep(100000);
    }
    if (fd < 0 || tcgetattr(fd, &attributes) != 0) return -1;
    cfmakeraw(&attributes);
    if (tcsetattr(fd, TCSANOW, &attributes) != 0) return -1;
    return fd;
}

static void prepare_pid1(void) {
    int console;
    int target;
    mkdir("/proc", 0555);
    mkdir("/sys", 0555);
    mkdir("/dev", 0755);
    mount("proc", "/proc", "proc", 0, NULL);
    mount("sysfs", "/sys", "sysfs", 0, NULL);
    mount("devtmpfs", "/dev", "devtmpfs", 0, "mode=0755");
    console = open("/dev/console", O_RDWR | O_NOCTTY);
    if (console >= 0) {
        for (target = STDIN_FILENO; target <= STDERR_FILENO; target += 1) {
            if (fcntl(target, F_GETFD) < 0 && errno == EBADF) dup2(console, target);
        }
        if (console > STDERR_FILENO) close(console);
    }
    signal(SIGPIPE, SIG_IGN);
}

static int handle_control(
    struct holo_process_table *table,
    struct holo_fuse_bridge *fuse,
    int fd,
    int *running
) {
    struct holo_frame frame;
    int result;
    if (holo_read_frame(fd, &frame) != 0) return -1;
    if (frame.operation == HOLO_SHUTDOWN) {
        result = frame.payload_length == 0 ? 0 : -1;
        *running = 0;
    } else if (frame.operation == HOLO_SPAWN && frame.process_id == 0 && frame.request_id != 0) {
        result = holo_process_spawn(table, fd, &frame);
    } else if (frame.operation == HOLO_FILESYSTEM_RESPONSE && frame.request_id != 0) {
        result = holo_fuse_bridge_response(fuse, &frame);
    } else if (
        (frame.operation == HOLO_STDIN || frame.operation == HOLO_STDIN_CLOSE ||
         frame.operation == HOLO_SIGNAL) && frame.process_id != 0 && frame.request_id != 0
    ) {
        result = holo_process_command(table, fd, &frame);
    } else {
        result = -1;
    }
    holo_frame_free(&frame);
    return result;
}

int main(void) {
    struct holo_fuse_bridge fuse;
    struct holo_process_table table;
    struct pollfd fds[HOLO_MAX_POLL_FDS];
    struct holo_poll_target targets[HOLO_MAX_POLL_FDS];
    int control_fd;
    int running = 1;
    prepare_pid1();
    control_fd = open_control();
    if (control_fd < 0) return 111;
    holo_process_table_init(&table);
    holo_fuse_bridge_init(&fuse);
    if (write_ready(control_fd, fuse.fd >= 0) != 0) return 112;
    while (running) {
        size_t count;
        size_t index;
        memset(fds, 0, sizeof(fds));
        memset(targets, 0, sizeof(targets));
        fds[0] = (struct pollfd){ control_fd, POLLIN, 0 };
        fds[1] = (struct pollfd){ fuse.fd, POLLIN, 0 };
        count = holo_process_poll_fds(&table, fds, targets, 2);
        if (poll(fds, (nfds_t)count, 50) < 0 && errno != EINTR) break;
        if ((fds[0].revents & (POLLIN | POLLERR | POLLHUP)) != 0 &&
            handle_control(&table, &fuse, control_fd, &running) != 0) break;
        if (running && holo_fuse_bridge_poll(&fuse, &table, control_fd, &fds[1]) != 0) break;
        for (index = 2; index < count && running; index += 1) {
            if (holo_process_poll_event(control_fd, &fds[index], &targets[index]) != 0) running = 0;
        }
        if (running && holo_process_reap(&table, control_fd) != 0) break;
    }
    holo_fuse_bridge_close(&fuse);
    holo_process_shutdown(&table);
    close(control_fd);
    return 0;
}
