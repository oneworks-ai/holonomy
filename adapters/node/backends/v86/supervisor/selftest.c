typedef unsigned int holo_size;

enum {
    HOLO_SYS_EXIT = 1,
    HOLO_SYS_READ = 3,
    HOLO_SYS_WRITE = 4,
    HOLO_SYS_OPEN = 5,
    HOLO_SYS_CLOSE = 6,
    HOLO_SYS_PAUSE = 29,
    HOLO_SYS_IOCTL = 54,
    HOLO_SYS_SOCKETCALL = 102
};

enum {
    HOLO_AF_INET = 2,
    HOLO_SOCK_DGRAM = 2,
    HOLO_SOCK_STREAM = 1,
    HOLO_SOCKET = 1,
    HOLO_CONNECT = 3,
    HOLO_SIOCSIFADDR = 0x8916,
    HOLO_SIOCSIFFLAGS = 0x8914,
    HOLO_SIOCSIFNETMASK = 0x891c,
    HOLO_IFF_UP = 1,
    HOLO_IFF_RUNNING = 64
};

struct holo_sockaddr_in {
    unsigned short family;
    unsigned short port;
    unsigned char address[4];
    unsigned char zero[8];
};

struct holo_ifreq {
    char name[16];
    union {
        struct holo_sockaddr_in address;
        short flags;
    } value;
};

static int syscall0(int number) {
    int result;
    __asm__ volatile("int $0x80" : "=a"(result) : "0"(number) : "memory");
    return result;
}

static int syscall1(int number, int value) {
    int result;
    __asm__ volatile("int $0x80" : "=a"(result) : "0"(number), "b"(value) : "memory");
    return result;
}

static int syscall2(int number, unsigned long first, unsigned long second) {
    int result;
    __asm__ volatile(
        "int $0x80" : "=a"(result) : "0"(number), "b"(first), "c"(second) : "memory"
    );
    return result;
}

static int syscall3(int number, unsigned long first, unsigned long second, unsigned long third) {
    int result;
    __asm__ volatile(
        "int $0x80" : "=a"(result) : "0"(number), "b"(first), "c"(second), "d"(third) : "memory"
    );
    return result;
}

static int string_equal(const char *left, const char *right) {
    while (*left != '\0' && *left == *right) {
        left += 1;
        right += 1;
    }
    return *left == *right;
}

static holo_size string_length(const char *value) {
    holo_size length = 0;
    while (value[length] != '\0') length += 1;
    return length;
}

static void zero_bytes(void *output, holo_size length) {
    holo_size index;
    unsigned char *bytes = output;
    for (index = 0; index < length; index += 1) bytes[index] = 0;
}

static void copy_text(char *output, const char *input, holo_size maximum) {
    holo_size index = 0;
    while (index + 1U < maximum && input[index] != '\0') {
        output[index] = input[index];
        index += 1;
    }
    output[index] = '\0';
}

static unsigned short network_u16(unsigned short value) {
    return (unsigned short)((value << 8U) | (value >> 8U));
}

static int socket_call(int operation, unsigned long *arguments) {
    return syscall2(HOLO_SYS_SOCKETCALL, (unsigned long)operation, (unsigned long)arguments);
}

static void set_interface_address(
    int socket_fd,
    unsigned long request,
    const unsigned char address[4]
) {
    struct holo_ifreq target;
    holo_size index;
    zero_bytes(&target, sizeof(target));
    copy_text(target.name, "eth0", sizeof(target.name));
    target.value.address.family = HOLO_AF_INET;
    for (index = 0; index < 4; index += 1) target.value.address.address[index] = address[index];
    if (syscall3(HOLO_SYS_IOCTL, socket_fd, request, (unsigned long)&target) < 0) {
        syscall1(HOLO_SYS_EXIT, 75);
    }
}

static void configure_network(void) {
    static const unsigned char address[4] = { 192, 168, 86, 100 };
    static const unsigned char netmask[4] = { 255, 255, 255, 0 };
    unsigned long arguments[3] = { HOLO_AF_INET, HOLO_SOCK_DGRAM, 0 };
    struct holo_ifreq flags;
    int socket_fd = socket_call(HOLO_SOCKET, arguments);
    if (socket_fd < 0) syscall1(HOLO_SYS_EXIT, 76);
    set_interface_address(socket_fd, HOLO_SIOCSIFADDR, address);
    set_interface_address(socket_fd, HOLO_SIOCSIFNETMASK, netmask);
    zero_bytes(&flags, sizeof(flags));
    copy_text(flags.name, "eth0", sizeof(flags.name));
    flags.value.flags = HOLO_IFF_UP | HOLO_IFF_RUNNING;
    if (syscall3(HOLO_SYS_IOCTL, socket_fd, HOLO_SIOCSIFFLAGS, (unsigned long)&flags) < 0) {
        syscall1(HOLO_SYS_EXIT, 77);
    }
    syscall1(HOLO_SYS_CLOSE, socket_fd);
}

static void write_all(int fd, const void *bytes, holo_size length) {
    holo_size offset = 0;
    while (offset < length) {
        int count = syscall3(
            HOLO_SYS_WRITE,
            (unsigned long)fd,
            (unsigned long)((const char *)bytes + offset),
            length - offset
        );
        if (count <= 0) syscall1(HOLO_SYS_EXIT, 70);
        offset += (holo_size)count;
    }
}

static void stdio_selftest(void) {
    static const char prefix[] = "REAL_STDOUT:";
    static const char diagnostic[] = "REAL_STDERR\n";
    char input[256];
    int count = syscall3(HOLO_SYS_READ, 0, (unsigned long)input, sizeof(input));
    if (count < 0) syscall1(HOLO_SYS_EXIT, 71);
    write_all(1, prefix, sizeof(prefix) - 1U);
    write_all(1, input, (holo_size)count);
    write_all(2, diagnostic, sizeof(diagnostic) - 1U);
    syscall1(HOLO_SYS_EXIT, 7);
}

static void fuse_selftest(void) {
    static const char input_path[] = "/workspace/input.txt";
    static const char output_path[] = "/workspace/output.txt";
    static const char prefix[] = "FUSE_INPUT:";
    static const char output[] = "GUEST_TO_HOST";
    char input[128];
    int input_fd = syscall3(HOLO_SYS_OPEN, (unsigned long)input_path, 0, 0);
    int count;
    int output_fd;
    if (input_fd < 0) syscall1(HOLO_SYS_EXIT, 72);
    count = syscall3(HOLO_SYS_READ, (unsigned long)input_fd, (unsigned long)input, sizeof(input));
    syscall1(HOLO_SYS_CLOSE, input_fd);
    if (count < 0) syscall1(HOLO_SYS_EXIT, 73);
    write_all(1, prefix, sizeof(prefix) - 1U);
    write_all(1, input, (holo_size)count);
    output_fd = syscall3(HOLO_SYS_OPEN, (unsigned long)output_path, 577, 0600);
    if (output_fd < 0) syscall1(HOLO_SYS_EXIT, 74);
    write_all(output_fd, output, sizeof(output) - 1U);
    syscall1(HOLO_SYS_CLOSE, output_fd);
    syscall1(HOLO_SYS_EXIT, 0);
}

static void network_selftest(const char *host_port) {
    static const unsigned char router[4] = { 192, 168, 86, 1 };
    static const char request_prefix[] = "GET /v86 HTTP/1.1\r\nHost: 127.0.0.1:";
    static const char request_suffix[] = "\r\nConnection: close\r\n\r\n";
    struct holo_sockaddr_in target;
    unsigned long socket_arguments[3] = { HOLO_AF_INET, HOLO_SOCK_STREAM, 0 };
    unsigned long connect_arguments[3];
    char response[512];
    int socket_fd;
    int count;
    holo_size index;
    configure_network();
    socket_fd = socket_call(HOLO_SOCKET, socket_arguments);
    if (socket_fd < 0) syscall1(HOLO_SYS_EXIT, 78);
    zero_bytes(&target, sizeof(target));
    target.family = HOLO_AF_INET;
    target.port = network_u16(80);
    for (index = 0; index < 4; index += 1) target.address[index] = router[index];
    connect_arguments[0] = (unsigned long)socket_fd;
    connect_arguments[1] = (unsigned long)&target;
    connect_arguments[2] = sizeof(target);
    if (socket_call(HOLO_CONNECT, connect_arguments) < 0) syscall1(HOLO_SYS_EXIT, 79);
    write_all(socket_fd, request_prefix, sizeof(request_prefix) - 1U);
    write_all(socket_fd, host_port, string_length(host_port));
    write_all(socket_fd, request_suffix, sizeof(request_suffix) - 1U);
    while ((count = syscall3(HOLO_SYS_READ, socket_fd, (unsigned long)response, sizeof(response))) > 0) {
        write_all(1, response, (holo_size)count);
    }
    syscall1(HOLO_SYS_CLOSE, socket_fd);
    if (count < 0) syscall1(HOLO_SYS_EXIT, 80);
    syscall1(HOLO_SYS_EXIT, 0);
}

void holo_selftest_start(unsigned long *stack) {
    int argc = (int)stack[0];
    char **argv = (char **)&stack[1];
    if (argc == 2 && string_equal(argv[1], "stdio-exit")) stdio_selftest();
    if (argc == 2 && string_equal(argv[1], "fuse")) fuse_selftest();
    if (argc == 3 && string_equal(argv[1], "network")) network_selftest(argv[2]);
    if (argc == 2 && string_equal(argv[1], "sleep")) {
        for (;;) syscall0(HOLO_SYS_PAUSE);
    }
    syscall1(HOLO_SYS_EXIT, 64);
    __builtin_unreachable();
}

__asm__(
    ".section .text\n"
    ".global _start\n"
    "_start:\n"
    "movl %esp, %eax\n"
    "pushl %eax\n"
    "call holo_selftest_start\n"
);
