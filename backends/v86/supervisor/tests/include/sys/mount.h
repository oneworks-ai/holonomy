#ifndef HOLO_TEST_SYS_MOUNT_H
#define HOLO_TEST_SYS_MOUNT_H

#define MS_NODEV 1
#define MS_NOEXEC 2
#define MS_NOSUID 4
#define MNT_DETACH 8

int mount(const char *source, const char *target, const char *type, unsigned long flags, const void *data);
int umount2(const char *target, int flags);

#endif
