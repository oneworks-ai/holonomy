#include <node_api.h>

#include <cmath>
#include <climits>
#include <cstddef>
#include <string>

#if defined(__APPLE__) || defined(__linux__)
#define HOLONOMY_POSIX_OPENAT 1
#include <cerrno>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#else
#define HOLONOMY_POSIX_OPENAT 0
#include <cerrno>
#endif

namespace holonomy_filesystem_openat {

// Deliberately avoid strerror and path-bearing OS exception constructors.
// The Provider translates these local errors into its own public error domain.
const char* ErrorCode(int value) {
#if !HOLONOMY_POSIX_OPENAT
  return value == ENOSYS ? "ENOSYS" : "EUNKNOWN";
#else
#define HOLO_ERRNO_CASE(name) case name: return #name
  switch (value) {
    HOLO_ERRNO_CASE(EPERM);
    HOLO_ERRNO_CASE(ENOENT);
    HOLO_ERRNO_CASE(EINTR);
    HOLO_ERRNO_CASE(EIO);
    HOLO_ERRNO_CASE(ENXIO);
#ifdef E2BIG
    HOLO_ERRNO_CASE(E2BIG);
#endif
    HOLO_ERRNO_CASE(EBADF);
#ifdef ECHILD
    HOLO_ERRNO_CASE(ECHILD);
#endif
    HOLO_ERRNO_CASE(EAGAIN);
    HOLO_ERRNO_CASE(ENOMEM);
    HOLO_ERRNO_CASE(EACCES);
#ifdef EFAULT
    HOLO_ERRNO_CASE(EFAULT);
#endif
    HOLO_ERRNO_CASE(EBUSY);
    HOLO_ERRNO_CASE(EEXIST);
    HOLO_ERRNO_CASE(EXDEV);
    HOLO_ERRNO_CASE(ENODEV);
    HOLO_ERRNO_CASE(ENOTDIR);
    HOLO_ERRNO_CASE(EISDIR);
    HOLO_ERRNO_CASE(EINVAL);
    HOLO_ERRNO_CASE(ENFILE);
    HOLO_ERRNO_CASE(EMFILE);
#ifdef ENOTTY
    HOLO_ERRNO_CASE(ENOTTY);
#endif
    HOLO_ERRNO_CASE(EFBIG);
    HOLO_ERRNO_CASE(ENOSPC);
    HOLO_ERRNO_CASE(EROFS);
    HOLO_ERRNO_CASE(EMLINK);
    HOLO_ERRNO_CASE(EPIPE);
#ifdef ESPIPE
    HOLO_ERRNO_CASE(ESPIPE);
#endif
    HOLO_ERRNO_CASE(ENAMETOOLONG);
    HOLO_ERRNO_CASE(ENOSYS);
    HOLO_ERRNO_CASE(ENOTEMPTY);
    HOLO_ERRNO_CASE(ELOOP);
#ifdef EOVERFLOW
    HOLO_ERRNO_CASE(EOVERFLOW);
#endif
#ifdef EOPNOTSUPP
    HOLO_ERRNO_CASE(EOPNOTSUPP);
#endif
#ifdef ESTALE
    HOLO_ERRNO_CASE(ESTALE);
#endif
#ifdef EDQUOT
    HOLO_ERRNO_CASE(EDQUOT);
#endif
#ifdef ETXTBSY
    HOLO_ERRNO_CASE(ETXTBSY);
#endif
#ifdef EDEADLK
    HOLO_ERRNO_CASE(EDEADLK);
#endif
#ifdef EILSEQ
    HOLO_ERRNO_CASE(EILSEQ);
#endif
#ifdef ECANCELED
    HOLO_ERRNO_CASE(ECANCELED);
#endif
    default: return "EUNKNOWN";
  }
#undef HOLO_ERRNO_CASE
#endif
}

napi_value ThrowErrno(napi_env env, int value) {
  napi_value message;
  napi_value code;
  napi_value error;
  napi_value errno_number;
  if (napi_create_string_utf8(env, "Node filesystem openat failed", NAPI_AUTO_LENGTH,
                              &message) != napi_ok ||
      napi_create_string_utf8(env, ErrorCode(value), NAPI_AUTO_LENGTH,
                              &code) != napi_ok ||
      napi_create_error(env, code, message, &error) != napi_ok ||
      napi_create_int32(env, value, &errno_number) != napi_ok ||
      napi_set_named_property(env, error, "code", code) != napi_ok ||
      napi_set_named_property(env, error, "errno", errno_number) != napi_ok) {
    return nullptr;
  }
  napi_throw(env, error);
  return nullptr;
}

bool ReadInt(napi_env env, napi_value value, int* output) {
  napi_valuetype kind;
  double number;
  if (napi_typeof(env, value, &kind) != napi_ok || kind != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !std::isfinite(number) || number != std::trunc(number) ||
      number < 0 || number > INT_MAX) {
    return false;
  }
  *output = static_cast<int>(number);
  return true;
}

#if HOLONOMY_POSIX_OPENAT
bool ValidUtf8(const std::string& value) {
  for (size_t index = 0; index < value.size();) {
    const unsigned char first = static_cast<unsigned char>(value[index++]);
    if (first < 0x80) continue;
    int continuation;
    unsigned int codepoint;
    unsigned int minimum;
    if (first >= 0xc2 && first <= 0xdf) {
      continuation = 1;
      codepoint = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuation = 2;
      codepoint = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuation = 3;
      codepoint = first & 0x07;
      minimum = 0x10000;
    } else {
      return false;
    }
    if (index + static_cast<size_t>(continuation) > value.size()) return false;
    while (continuation-- > 0) {
      const unsigned char next = static_cast<unsigned char>(value[index++]);
      if ((next & 0xc0) != 0x80) return false;
      codepoint = (codepoint << 6) | (next & 0x3f);
    }
    if (codepoint < minimum || codepoint > 0x10ffff ||
        (codepoint >= 0xd800 && codepoint <= 0xdfff)) return false;
  }
  return true;
}

bool ReadTime(napi_env env, napi_value value, struct timespec* output) {
  napi_value kind_value;
  size_t kind_length;
  char kind[16];
  if (napi_get_named_property(env, value, "kind", &kind_value) != napi_ok ||
      napi_get_value_string_utf8(env, kind_value, kind, sizeof(kind), &kind_length) != napi_ok) {
    return false;
  }
  const std::string tag(kind, kind_length);
  if (tag == "now" || tag == "omit") {
    output->tv_sec = 0;
    output->tv_nsec = tag == "now" ? UTIME_NOW : UTIME_OMIT;
    return true;
  }
  if (tag != "set") return false;
  napi_value seconds_value;
  napi_value nanoseconds_value;
  double seconds;
  double nanoseconds;
  if (napi_get_named_property(env, value, "seconds", &seconds_value) != napi_ok ||
      napi_get_named_property(env, value, "nanoseconds", &nanoseconds_value) != napi_ok ||
      napi_get_value_double(env, seconds_value, &seconds) != napi_ok ||
      napi_get_value_double(env, nanoseconds_value, &nanoseconds) != napi_ok ||
      !std::isfinite(seconds) || seconds != std::trunc(seconds) ||
      seconds < 0 || seconds > 253402300799.0 ||
      !std::isfinite(nanoseconds) || nanoseconds != std::trunc(nanoseconds) ||
      nanoseconds < 0 || nanoseconds > 999999999.0) {
    return false;
  }
  output->tv_sec = static_cast<time_t>(seconds);
  output->tv_nsec = static_cast<long>(nanoseconds);
  return true;
}

napi_value Futimens(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  int fd;
  struct timespec times[2];
  if (argc != 3 || !ReadInt(env, argv[0], &fd) ||
      !ReadTime(env, argv[1], &times[0]) || !ReadTime(env, argv[2], &times[1])) {
    return ThrowErrno(env, EINVAL);
  }
  struct stat pinned;
  if (fstat(fd, &pinned) != 0) return ThrowErrno(env, errno);
  if (!S_ISREG(pinned.st_mode) && !S_ISDIR(pinned.st_mode)) return ThrowErrno(env, EINVAL);
  int result;
  do { result = futimens(fd, times); } while (result != 0 && errno == EINTR);
  if (result != 0) return ThrowErrno(env, errno);
  napi_value output;
  if (napi_get_undefined(env, &output) != napi_ok) return nullptr;
  return output;
}

napi_value AccessDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  int fd;
  int mode;
  if (argc != 2 || !ReadInt(env, argv[0], &fd) || !ReadInt(env, argv[1], &mode) ||
      (mode & ~(R_OK | W_OK | X_OK)) != 0) return ThrowErrno(env, EINVAL);
  struct stat pinned;
  if (fstat(fd, &pinned) != 0) return ThrowErrno(env, errno);
  if (!S_ISDIR(pinned.st_mode)) return ThrowErrno(env, ENOTDIR);
#ifdef AT_EACCESS
  constexpr int flags = AT_EACCESS;
#else
  constexpr int flags = 0;
#endif
  int result;
  do { result = faccessat(fd, ".", mode, flags); } while (result != 0 && errno == EINTR);
  if (result != 0) return ThrowErrno(env, errno);
  napi_value output;
  if (napi_get_undefined(env, &output) != napi_ok) return nullptr;
  return output;
}

napi_value ReadDirectoryFd(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  int fd;
  int maximum;
  if (argc != 2 || !ReadInt(env, argv[0], &fd) || !ReadInt(env, argv[1], &maximum) ||
      maximum < 1 || maximum > 100001) return ThrowErrno(env, EINVAL);
  struct stat pinned;
  if (fstat(fd, &pinned) != 0) return ThrowErrno(env, errno);
  if (!S_ISDIR(pinned.st_mode)) return ThrowErrno(env, ENOTDIR);
  const int duplicate = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return ThrowErrno(env, errno);
  DIR* directory = fdopendir(duplicate);
  if (directory == nullptr) {
    const int failure = errno;
    close(duplicate);
    return ThrowErrno(env, failure);
  }
  napi_value entries;
  if (napi_create_array(env, &entries) != napi_ok) {
    closedir(directory);
    return nullptr;
  }
  int count = 0;
  for (;;) {
    errno = 0;
    struct dirent* item = readdir(directory);
    if (item == nullptr) {
      const int failure = errno;
      closedir(directory);
      return failure == 0 ? entries : ThrowErrno(env, failure);
    }
    const std::string name(item->d_name);
    if (name == "." || name == "..") continue;
    if (!ValidUtf8(name)) {
      closedir(directory);
      return ThrowErrno(env, EILSEQ);
    }
    if (count >= maximum) {
      closedir(directory);
      return ThrowErrno(env, EOVERFLOW);
    }
    const char* kind = nullptr;
    if (item->d_type == DT_REG) kind = "file";
    else if (item->d_type == DT_DIR) kind = "directory";
    else if (item->d_type == DT_LNK) kind = "symlink";
    else {
      struct stat entry_stat;
      if (fstatat(fd, name.c_str(), &entry_stat, AT_SYMLINK_NOFOLLOW) != 0) {
        const int failure = errno;
        closedir(directory);
        return ThrowErrno(env, failure);
      }
      kind = S_ISREG(entry_stat.st_mode) ? "file" :
             S_ISDIR(entry_stat.st_mode) ? "directory" :
             S_ISLNK(entry_stat.st_mode) ? "symlink" : nullptr;
    }
    if (kind == nullptr) {
      closedir(directory);
      return ThrowErrno(env, EINVAL);
    }
    napi_value entry;
    napi_value name_value;
    napi_value kind_value;
    if (napi_create_object(env, &entry) != napi_ok ||
        napi_create_string_utf8(env, name.c_str(), name.size(), &name_value) != napi_ok ||
        napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &kind_value) != napi_ok ||
        napi_set_named_property(env, entry, "name", name_value) != napi_ok ||
        napi_set_named_property(env, entry, "kind", kind_value) != napi_ok ||
        napi_set_element(env, entries, count, entry) != napi_ok) {
      closedir(directory);
      return nullptr;
    }
    ++count;
  }
}

napi_value DuplicateDirectoryFd(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  int fd;
  if (argc != 1 || !ReadInt(env, argv[0], &fd)) return ThrowErrno(env, EINVAL);
  struct stat pinned;
  if (fstat(fd, &pinned) != 0) return ThrowErrno(env, errno);
  if (!S_ISDIR(pinned.st_mode)) return ThrowErrno(env, ENOTDIR);
  const int copy = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (copy < 0) return ThrowErrno(env, errno);
  napi_value output;
  if (napi_create_int32(env, copy, &output) != napi_ok) {
    close(copy);
    return nullptr;
  }
  return output;
}
#endif

int ReadLeaf(napi_env env, napi_value value, std::string* output) {
  napi_valuetype kind;
  size_t length;
  size_t unit_length;
  if (napi_typeof(env, value, &kind) != napi_ok || kind != napi_string ||
      napi_get_value_string_utf16(env, value, nullptr, 0, &unit_length) != napi_ok) {
    return EINVAL;
  }
  if (unit_length > 255) return ENAMETOOLONG;
  char16_t units[256];
  size_t units_written;
  if (napi_get_value_string_utf16(env, value, units, 256, &units_written) != napi_ok ||
      units_written != unit_length) {
    return EINVAL;
  }
  for (size_t index = 0; index < unit_length; ++index) {
    if (units[index] >= 0xd800 && units[index] <= 0xdbff) {
      if (index + 1 >= unit_length ||
          units[index + 1] < 0xdc00 || units[index + 1] > 0xdfff) {
        return EINVAL;
      }
      ++index;
    } else if (units[index] >= 0xdc00 && units[index] <= 0xdfff) {
      return EINVAL;
    }
  }
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return EINVAL;
  }
  if (length > 255) return ENAMETOOLONG;
  char bytes[256];
  size_t written;
  if (napi_get_value_string_utf8(env, value, bytes, sizeof(bytes), &written) !=
          napi_ok ||
      written != length) {
    return EINVAL;
  }
  if (length == 0 ||
      (length == 1 && bytes[0] == '.') ||
      (length == 2 && bytes[0] == '.' && bytes[1] == '.')) {
    return EINVAL;
  }
  for (size_t index = 0; index < length; ++index) {
    if (bytes[index] == '\0' || bytes[index] == '/') return EINVAL;
  }
  output->assign(bytes, length);
  return 0;
}

napi_value OpenAt(napi_env env, napi_callback_info info) {
#if !HOLONOMY_POSIX_OPENAT
  return ThrowErrno(env, ENOSYS);
#else
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    return nullptr;
  }
  if (argc < 3) return ThrowErrno(env, EINVAL);

  int parent_fd;
  int flags;
  int mode = 0600;
  std::string leaf;
  if (!ReadInt(env, argv[0], &parent_fd) ||
      !ReadInt(env, argv[2], &flags) ||
      (argc >= 4 && !ReadInt(env, argv[3], &mode))) {
    return ThrowErrno(env, EINVAL);
  }
  const int leaf_error = ReadLeaf(env, argv[1], &leaf);
  if (leaf_error != 0) return ThrowErrno(env, leaf_error);
  if (mode != 0600) return ThrowErrno(env, EINVAL);

  constexpr int allowed = O_ACCMODE | O_APPEND | O_CREAT | O_EXCL |
                          O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
  const int access = flags & O_ACCMODE;
  if ((flags & ~allowed) != 0 ||
      (access != O_RDONLY && access != O_WRONLY && access != O_RDWR) ||
      ((flags & O_EXCL) != 0 && (flags & O_CREAT) == 0) ||
      ((flags & O_DIRECTORY) != 0 && (flags & O_CREAT) != 0)) {
    return ThrowErrno(env, EINVAL);
  }

  struct stat parent_stat;
  if (fstat(parent_fd, &parent_stat) != 0) return ThrowErrno(env, errno);
  if (!S_ISDIR(parent_stat.st_mode)) return ThrowErrno(env, ENOTDIR);

  const int safe_flags = flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
  int fd;
  do {
    fd = openat(parent_fd, leaf.c_str(), safe_flags, 0600);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return ThrowErrno(env, errno);

  struct stat result_stat;
  if (fstat(fd, &result_stat) != 0) {
    const int failure = errno;
    close(fd);
    return ThrowErrno(env, failure);
  }
  const bool directory = (flags & O_DIRECTORY) != 0;
  if (directory ? !S_ISDIR(result_stat.st_mode) : !S_ISREG(result_stat.st_mode)) {
    const int failure = directory ? ENOTDIR : S_ISDIR(result_stat.st_mode) ? EISDIR : EINVAL;
    close(fd);
    return ThrowErrno(env, failure);
  }

  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    close(fd);
    return nullptr;
  }
  return result;
#endif
}

napi_value AccessAt(napi_env env, napi_callback_info info) {
#if !HOLONOMY_POSIX_OPENAT
  return ThrowErrno(env, ENOSYS);
#else
  size_t argc = 3;
  napi_value argv[3];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  int parent_fd;
  int mode;
  std::string leaf;
  if (argc != 3 || !ReadInt(env, argv[0], &parent_fd) || !ReadInt(env, argv[2], &mode) ||
      (mode & ~(R_OK | W_OK | X_OK)) != 0) return ThrowErrno(env, EINVAL);
  const int leaf_error = ReadLeaf(env, argv[1], &leaf);
  if (leaf_error != 0) return ThrowErrno(env, leaf_error);
  struct stat parent_stat;
  if (fstat(parent_fd, &parent_stat) != 0) return ThrowErrno(env, errno);
  if (!S_ISDIR(parent_stat.st_mode)) return ThrowErrno(env, ENOTDIR);
  struct stat before;
  struct stat after;
  if (fstatat(parent_fd, leaf.c_str(), &before, AT_SYMLINK_NOFOLLOW) != 0) {
    return ThrowErrno(env, errno);
  }
  if (!S_ISREG(before.st_mode) && !S_ISDIR(before.st_mode)) return ThrowErrno(env, EINVAL);
  int result;
  do {
    result = faccessat(parent_fd, leaf.c_str(), mode, AT_EACCESS | AT_SYMLINK_NOFOLLOW);
  } while (result != 0 && errno == EINTR);
  if (result != 0) return ThrowErrno(env, errno);
  if (fstatat(parent_fd, leaf.c_str(), &after, AT_SYMLINK_NOFOLLOW) != 0) {
    return ThrowErrno(env, errno);
  }
#if defined(__APPLE__)
  const auto before_mtime = before.st_mtimespec;
  const auto after_mtime = after.st_mtimespec;
  const auto before_ctime = before.st_ctimespec;
  const auto after_ctime = after.st_ctimespec;
#else
  const auto before_mtime = before.st_mtim;
  const auto after_mtime = after.st_mtim;
  const auto before_ctime = before.st_ctim;
  const auto after_ctime = after.st_ctim;
#endif
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_mode != after.st_mode || before.st_size != after.st_size ||
      before_mtime.tv_sec != after_mtime.tv_sec || before_mtime.tv_nsec != after_mtime.tv_nsec ||
      before_ctime.tv_sec != after_ctime.tv_sec || before_ctime.tv_nsec != after_ctime.tv_nsec) {
    return ThrowErrno(env, ESTALE);
  }
  napi_value output;
  if (napi_create_object(env, &output) != napi_ok) return nullptr;
  const auto put = [&](const char* name, const std::string& value) {
    napi_value item;
    return napi_create_string_utf8(env, value.c_str(), value.size(), &item) == napi_ok &&
           napi_set_named_property(env, output, name, item) == napi_ok;
  };
  if (!put("dev", std::to_string(static_cast<unsigned long long>(after.st_dev))) ||
      !put("ino", std::to_string(static_cast<unsigned long long>(after.st_ino))) ||
      !put("mode", std::to_string(static_cast<unsigned long long>(after.st_mode))) ||
      !put("size", std::to_string(static_cast<long long>(after.st_size))) ||
      !put("mtimeSec", std::to_string(static_cast<long long>(after_mtime.tv_sec))) ||
      !put("mtimeNsec", std::to_string(static_cast<long long>(after_mtime.tv_nsec))) ||
      !put("ctimeSec", std::to_string(static_cast<long long>(after_ctime.tv_sec))) ||
      !put("ctimeNsec", std::to_string(static_cast<long long>(after_ctime.tv_nsec)))) return nullptr;
  return output;
#endif
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"openAt", nullptr, OpenAt, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"accessAt", nullptr, AccessAt, nullptr, nullptr, nullptr, napi_default, nullptr},
#if HOLONOMY_POSIX_OPENAT
      {"futimens", nullptr, Futimens, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"accessDirectory", nullptr, AccessDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readDirectoryFd", nullptr, ReadDirectoryFd, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"duplicateDirectoryFd", nullptr, DuplicateDirectoryFd, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return nullptr;
  return exports;
}

}  // namespace holonomy_filesystem_openat

NAPI_MODULE(NODE_GYP_MODULE_NAME, holonomy_filesystem_openat::Initialize)
