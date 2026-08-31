typedef unsigned int holo_size;

enum {
    HOLO_SYS_EXIT = 1,
    HOLO_SYS_FORK = 2,
    HOLO_SYS_READ = 3,
    HOLO_SYS_WRITE = 4,
    HOLO_SYS_OPEN = 5,
    HOLO_SYS_CLOSE = 6,
    HOLO_SYS_WAITPID = 7,
    HOLO_SYS_EXECVE = 11,
    HOLO_SYS_PAUSE = 29,
    HOLO_SYS_SOCKETCALL = 102,
    HOLO_SYS_EXECVEAT = 358
};

enum {
    HOLO_AT_FDCWD = -100,
    HOLO_AT_EMPTY_PATH = 0x1000
};

enum {
    HOLO_AF_INET = 2,
    HOLO_SOCK_DGRAM = 2,
    HOLO_SOCK_STREAM = 1,
    HOLO_SOCKET = 1,
    HOLO_CONNECT = 3
};

struct holo_sockaddr_in {
    unsigned short family;
    unsigned short port;
    unsigned char address[4];
    unsigned char zero[8];
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

static int syscall5(
    int number,
    unsigned long first,
    unsigned long second,
    unsigned long third,
    unsigned long fourth,
    unsigned long fifth
) {
    int result;
    __asm__ volatile(
        "int $0x80"
        : "=a"(result)
        : "0"(number), "b"(first), "c"(second), "d"(third), "S"(fourth), "D"(fifth)
        : "memory"
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

static unsigned short network_u16(unsigned short value) {
    return (unsigned short)((value << 8U) | (value >> 8U));
}

static int socket_call(int operation, unsigned long *arguments) {
    return syscall2(HOLO_SYS_SOCKETCALL, (unsigned long)operation, (unsigned long)arguments);
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

static void descendant_selftest(char **envp) {
    static const char executable[] = "/usr/bin/holo-v86-selftest";
    static const char denied_executable[] = "/holo-denied";
    static const char allowed_output[] = "DESCENDANT_ALLOWED\n";
    static const char denied_output[] = "DESCENDANT_DENIED\n";
    char *allowed_argv[] = { (char *)executable, "descendant-child", 0 };
    char *denied_argv[] = { (char *)denied_executable, "descendant-child", 0 };
    int status = 0;
    int pid = syscall0(HOLO_SYS_FORK);
    if (pid < 0) syscall1(HOLO_SYS_EXIT, 81);
    if (pid == 0) {
        syscall3(HOLO_SYS_EXECVE, (unsigned long)executable, (unsigned long)allowed_argv, (unsigned long)envp);
        write_all(1, "DESCENDANT_EXEC_FAILED\n", 23);
        syscall1(HOLO_SYS_EXIT, 82);
    }
    if (syscall3(HOLO_SYS_WAITPID, (unsigned long)pid, (unsigned long)&status, 0) != pid || status != (13 << 8)) {
        syscall1(HOLO_SYS_EXIT, 83);
    }
    pid = syscall0(HOLO_SYS_FORK);
    if (pid < 0) syscall1(HOLO_SYS_EXIT, 84);
    if (pid == 0) {
        if (syscall3(
            HOLO_SYS_EXECVE,
            (unsigned long)denied_executable,
            (unsigned long)denied_argv,
            (unsigned long)envp
        ) >= 0) syscall1(HOLO_SYS_EXIT, 85);
        write_all(1, denied_output, sizeof(denied_output) - 1U);
        syscall1(HOLO_SYS_EXIT, 0);
    }
    if (syscall3(HOLO_SYS_WAITPID, (unsigned long)pid, (unsigned long)&status, 0) != pid || status != 0) {
        syscall1(HOLO_SYS_EXIT, 86);
    }
    write_all(1, allowed_output, sizeof(allowed_output) - 1U);
    syscall1(HOLO_SYS_EXIT, 0);
}

static void descendant_denied_selftest(char **envp) {
    static const char executable[] = "/usr/bin/holo-v86-selftest";
    static const char output[] = "DESCENDANT_HOST_DENIED\n";
    char *argv[] = { (char *)executable, "descendant-child", 0 };
    int status = 0;
    int pid = syscall0(HOLO_SYS_FORK);
    if (pid < 0) syscall1(HOLO_SYS_EXIT, 87);
    if (pid == 0) {
        if (syscall3(
            HOLO_SYS_EXECVE,
            (unsigned long)executable,
            (unsigned long)argv,
            (unsigned long)envp
        ) >= 0) syscall1(HOLO_SYS_EXIT, 88);
        write_all(1, output, sizeof(output) - 1U);
        syscall1(HOLO_SYS_EXIT, 0);
    }
    if (syscall3(HOLO_SYS_WAITPID, (unsigned long)pid, (unsigned long)&status, 0) != pid || status != 0) {
        syscall1(HOLO_SYS_EXIT, 89);
    }
    syscall1(HOLO_SYS_EXIT, 0);
}

static void execveat_selftest(char **envp) {
    static const char executable[] = "/usr/bin/holo-v86-selftest";
    static const char relative_executable[] = "usr/bin/holo-v86-selftest";
    static const char empty_path[] = "";
    static const char output[] =
        "EXECVEAT_ABSOLUTE_ALLOWED\nEXECVEAT_RELATIVE_DENIED\nEXECVEAT_DIRFD_DENIED\n"
        "EXECVEAT_EMPTY_PATH_DENIED\n";
    char *allowed_argv[] = { (char *)executable, "descendant-child", 0 };
    int status = 0;
    int pid = syscall0(HOLO_SYS_FORK);
    if (pid < 0) syscall1(HOLO_SYS_EXIT, 90);
    if (pid == 0) {
        int result = syscall5(
            HOLO_SYS_EXECVEAT,
            (unsigned long)HOLO_AT_FDCWD,
            (unsigned long)executable,
            (unsigned long)allowed_argv,
            (unsigned long)envp,
            0
        );
        syscall1(HOLO_SYS_EXIT, result < 0 ? 100 - result : 91);
    }
    if (syscall3(HOLO_SYS_WAITPID, (unsigned long)pid, (unsigned long)&status, 0) != pid || status != (13 << 8)) {
        int child_code = (status >> 8) & 255;
        syscall1(HOLO_SYS_EXIT, child_code == 0 ? 92 : child_code);
    }
    if (syscall5(
        HOLO_SYS_EXECVEAT,
        (unsigned long)HOLO_AT_FDCWD,
        (unsigned long)relative_executable,
        (unsigned long)allowed_argv,
        (unsigned long)envp,
        0
    ) >= 0) syscall1(HOLO_SYS_EXIT, 93);
    if (syscall5(
        HOLO_SYS_EXECVEAT,
        0,
        (unsigned long)relative_executable,
        (unsigned long)allowed_argv,
        (unsigned long)envp,
        0
    ) >= 0) syscall1(HOLO_SYS_EXIT, 94);
    if (syscall5(
        HOLO_SYS_EXECVEAT,
        0,
        (unsigned long)empty_path,
        (unsigned long)allowed_argv,
        (unsigned long)envp,
        HOLO_AT_EMPTY_PATH
    ) >= 0) syscall1(HOLO_SYS_EXIT, 95);
    write_all(1, output, sizeof(output) - 1U);
    syscall1(HOLO_SYS_EXIT, 0);
}

static void exec_failure_selftest(char **envp) {
    static const char invalid_executable[] = "/usr/bin/holo-v86-invalid-executable";
    static const char executable[] = "/usr/bin/holo-v86-selftest";
    static const char returned[] = "EXEC_FAILURE_RETURNED\n";
    static const char recovered[] = "EXEC_FAILURE_IDENTITY_RECOVERED\n";
    char *invalid_argv[] = { (char *)invalid_executable, 0 };
    char *valid_argv[] = { (char *)executable, "descendant-child", 0 };
    int status = 0;
    int pid = syscall0(HOLO_SYS_FORK);
    if (pid < 0) syscall1(HOLO_SYS_EXIT, 96);
    if (pid == 0) {
        if (syscall3(
            HOLO_SYS_EXECVE,
            (unsigned long)invalid_executable,
            (unsigned long)invalid_argv,
            (unsigned long)envp
        ) >= 0) syscall1(HOLO_SYS_EXIT, 97);
        write_all(1, returned, sizeof(returned) - 1U);
        syscall3(
            HOLO_SYS_EXECVE,
            (unsigned long)executable,
            (unsigned long)valid_argv,
            (unsigned long)envp
        );
        syscall1(HOLO_SYS_EXIT, 98);
    }
    if (syscall3(HOLO_SYS_WAITPID, (unsigned long)pid, (unsigned long)&status, 0) != pid || status != (13 << 8)) {
        syscall1(HOLO_SYS_EXIT, 99);
    }
    write_all(1, recovered, sizeof(recovered) - 1U);
    syscall1(HOLO_SYS_EXIT, 0);
}

void holo_selftest_start(unsigned long *stack) {
    int argc = (int)stack[0];
    char **argv = (char **)&stack[1];
    char **envp = &argv[argc + 1];
    if (argc == 2 && string_equal(argv[1], "stdio-exit")) stdio_selftest();
    if (argc == 2 && string_equal(argv[1], "fuse")) fuse_selftest();
    if (argc == 3 && string_equal(argv[1], "network")) network_selftest(argv[2]);
    if (argc == 2 && string_equal(argv[1], "descendant")) descendant_selftest(envp);
    if (argc == 2 && string_equal(argv[1], "descendant-denied")) descendant_denied_selftest(envp);
    if (argc == 2 && string_equal(argv[1], "execveat")) execveat_selftest(envp);
    if (argc == 2 && string_equal(argv[1], "exec-failure")) exec_failure_selftest(envp);
    if (argc == 2 && string_equal(argv[1], "descendant-child")) syscall1(HOLO_SYS_EXIT, 13);
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
