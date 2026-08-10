export const FS_NATIVE_MODULE = 'host.fs'
export const FS_OPERATION_VERSION = 1
export const FS_REQUIRED_CAPABILITY = 'host.fs.v1'
export const FS_VIRTUAL_SCHEME = 'holonomy-fs'

export const FS_ROOT_AUTHORITIES = Object.freeze(
  [
    'app-data',
    'workspace',
    'temp'
  ] as const
)

export const constants = Object.freeze({
  COPYFILE_EXCL: 1,
  F_OK: 0,
  O_APPEND: 0x400,
  O_CREAT: 0x40,
  O_DIRECTORY: 0x10000,
  O_EXCL: 0x80,
  O_NOFOLLOW: 0x20000,
  O_RDONLY: 0,
  O_RDWR: 2,
  O_TRUNC: 0x200,
  O_WRONLY: 1,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1
})

export const FS_OPERATIONS = Object.freeze({
  access: 'v1.access',
  atomicWriteBegin: 'v1.atomic-write.begin',
  atomicWriteChunk: 'v1.atomic-write.chunk',
  atomicWriteCommit: 'v1.atomic-write.commit',
  chmod: 'v1.chmod',
  cp: 'v1.cp',
  handleRead: 'v1.handle.read',
  handleStat: 'v1.handle.stat',
  handleSync: 'v1.handle.sync',
  handleWrite: 'v1.handle.write',
  lstat: 'v1.lstat',
  mkdir: 'v1.mkdir',
  open: 'v1.open',
  readStream: 'v1.read-stream',
  readlink: 'v1.readlink',
  readdir: 'v1.readdir',
  realpath: 'v1.realpath',
  rename: 'v1.rename',
  rm: 'v1.rm',
  stat: 'v1.stat',
  symlink: 'v1.symlink',
  watch: 'v1.watch'
})

export type FsOperation = typeof FS_OPERATIONS[keyof typeof FS_OPERATIONS]
