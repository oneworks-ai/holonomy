#include "network.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <net/route.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void interface_request(struct ifreq *request, const char *name) {
    memset(request, 0, sizeof(*request));
    strncpy(request->ifr_name, name, IFNAMSIZ - 1);
}

static int interface_address(int fd, const char *name, unsigned long operation, const char *address) {
    struct ifreq request;
    struct sockaddr_in *target;
    interface_request(&request, name);
    target = (struct sockaddr_in *)&request.ifr_addr;
    target->sin_family = AF_INET;
    if (inet_pton(AF_INET, address, &target->sin_addr) != 1) return -1;
    return ioctl(fd, operation, &request);
}

static int interface_up(int fd, const char *name) {
    struct ifreq request;
    interface_request(&request, name);
    if (ioctl(fd, SIOCGIFFLAGS, &request) != 0) return -1;
    request.ifr_flags |= IFF_UP;
    return ioctl(fd, SIOCSIFFLAGS, &request);
}

static int find_network_interface(char output[IFNAMSIZ]) {
    int attempt;
    for (attempt = 0; attempt < 100; attempt += 1) {
        struct if_nameindex *interfaces = if_nameindex();
        struct if_nameindex *current = interfaces;
        while (current != NULL && current->if_index != 0) {
            if (strcmp(current->if_name, "lo") != 0) {
                strncpy(output, current->if_name, IFNAMSIZ - 1);
                output[IFNAMSIZ - 1] = '\0';
                if_freenameindex(interfaces);
                return 0;
            }
            current += 1;
        }
        if (interfaces != NULL) if_freenameindex(interfaces);
        usleep(10000);
    }
    errno = ENODEV;
    return -1;
}

static int default_route(int fd, const char *name) {
    struct rtentry route;
    struct sockaddr_in *destination;
    struct sockaddr_in *gateway;
    struct sockaddr_in *mask;
    memset(&route, 0, sizeof(route));
    destination = (struct sockaddr_in *)&route.rt_dst;
    gateway = (struct sockaddr_in *)&route.rt_gateway;
    mask = (struct sockaddr_in *)&route.rt_genmask;
    destination->sin_family = AF_INET;
    gateway->sin_family = AF_INET;
    mask->sin_family = AF_INET;
    if (inet_pton(AF_INET, "192.168.86.1", &gateway->sin_addr) != 1) return -1;
    route.rt_flags = RTF_UP | RTF_GATEWAY;
    route.rt_dev = (char *)name;
    if (ioctl(fd, SIOCADDRT, &route) == 0 || errno == EEXIST) return 0;
    return -1;
}

static void write_resolver(void) {
    static const char value[] = "nameserver 192.168.86.1\noptions attempts:1 timeout:1\n";
    int fd = open("/etc/resolv.conf", O_CLOEXEC | O_CREAT | O_TRUNC | O_WRONLY, 0644);
    if (fd < 0) return;
    if (write(fd, value, sizeof(value) - 1U) < 0) {}
    close(fd);
}

int holo_network_prepare(void) {
    char interface[IFNAMSIZ] = { 0 };
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    int result = 0;
    if (fd < 0) return -1;
    if (
        find_network_interface(interface) != 0 ||
        interface_address(fd, "lo", SIOCSIFADDR, "127.0.0.1") != 0 ||
        interface_address(fd, "lo", SIOCSIFNETMASK, "255.0.0.0") != 0 ||
        interface_up(fd, "lo") != 0 ||
        interface_address(fd, interface, SIOCSIFADDR, "192.168.86.100") != 0 ||
        interface_address(fd, interface, SIOCSIFNETMASK, "255.255.255.0") != 0 ||
        interface_up(fd, interface) != 0 || default_route(fd, interface) != 0
    ) result = -1;
    close(fd);
    if (result == 0) write_resolver();
    return result;
}
