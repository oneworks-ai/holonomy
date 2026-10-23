# RFC-0001 附录 H：`node:fs` Sandbox v1

[返回 RFC 总览](../0001-holo-capability-runtime.md)

v1 是明确的 production 子集，不声称实现全部 Node FS。未列为 supported 的 export 由 Synthetic Module 缺失导出或稳定 `ERR_METHOD_NOT_IMPLEMENTED` 表达，永不回退 ambient `node:fs`。

每个supported export/overload的args/result/callback tuple/right/syscall由[附录 H.1](filesystem-operation-registry.md)及其[H.2 扩展](filesystem-metadata-and-durability.md)唯一冻结；本页matrix只做能力导航，平台实际支持须另有执行证据。

## H.1 Capability matrix

| Operation family                         | `node:fs` sync       | callback            | `node:fs/promises`        | v1                                 |
| ---------------------------------------- | -------------------- | ------------------- | ------------------------- | ---------------------------------- |
| readFile/writeFile                       | `*Sync`              | functions           | functions                 | supported                          |
| open/close                               | `openSync/closeSync` | functions           | `open`+FileHandle.close   | supported                          |
| stat/lstat                               | `*Sync`              | functions           | functions/FileHandle.stat | supported                          |
| readdir/mkdir                            | `*Sync`              | functions           | functions                 | supported                          |
| rename/unlink                            | `*Sync`              | functions           | functions                 | supported                          |
| watch                                    | `watch` resource     | `watch` listener    | `watch` AsyncIterable     | partial, same event contract       |
| fd/FileHandle readFile/writeFile         | methods/input fd     | functions accept fd | FileHandle methods        | supported                          |
| partial read/write/readv/writev          | exports              | exports             | FileHandle methods        | unsupported                        |
| streams/Dir/opendir                      | exports              | exports             | exports                   | unsupported                        |
| realpath/readlink/symlink/link           | exports              | exports             | exports                   | unsupported                        |
| utimes/futimes/truncate/ftruncate/access | functions            | functions           | functions/FileHandle      | partial, H.2 exact inputs          |
| fsync/fdatasync                          | functions            | functions           | FileHandle.sync/datasync  | supported contract, H.2            |
| chmod/fchmod                             | functions            | functions           | chmod/FileHandle.chmod    | partial, explicit chmod right, H.3 |
| chown/copy/cp/rm/mkdtemp                 | exports              | exports             | exports                   | unsupported                        |

所有 supported sync/callback/promise 入口映射到 §15 的同一 operation。callback 异步 exactly-once；Promise/async options支持 Runtime-captured AbortSignal，sync 不接受 signal。

## H.2 Path 与 options

```ts
type VirtualPathV1 = string // canonical holo-fs://<rootId>/<segments>
type FsEncodingV1 = null | 'utf8' | 'utf-8' | 'base64' | 'hex'
type FsOpenFlagV1 =
  | 'r'
  | 'r+'
  | 'w'
  | 'wx'
  | 'w+'
  | 'wx+'
  | 'a'
  | 'ax'
  | 'a+'
  | 'ax+'

interface FsPortableOpenFlagV1 {
  readonly kind: 'portable-open-v1'
  readonly access: 'read' | 'write' | 'readWrite'
  readonly create: boolean
  readonly exclusive: boolean
  readonly truncate: boolean
  readonly append: boolean
}
type KernelOpenFlagV1 = FsOpenFlagV1 | FsPortableOpenFlagV1
```

Read/write/readdir/mkdir options 会随sync/async参数选择结果或取消语义，全部由附录 H.1 唯一定义，避免导航页与 Operation Registry 重复 owner。

`FsPortableOpenFlagV1`仅是可信 Linux Capability Source 的内部 normalized open 分支；公开 Node facade仍只接受上述 string flags，不能由Guest直接传入record。`FsOpenArgsV1.flag`在Kernel准入此discriminant后，沿同一个`filesystem.file.open`、snapshot、resource与Provider链传递；Host Middleware看到真实create/truncate/append意图，不能用`w`加隐藏hint伪装无截断打开。

record必须strict unknown=false。`exclusive=true`要求`create=true`；read-only禁止truncate/append。open操作的必要rights与返回handle的access分开：任何create/truncate/append都要求write；read-only+create同时要求read/write，但返回句柄仍不可写。existing+create且无truncate保持内容；missing+create=false固定ENOENT；exclusive创建existing固定EEXIST。Node Provider用本机`fs.constants`，Native用本机`libc`，单次授权后原子open，禁止stat后再w。append在带offset的Linux写请求中仍追加，不因Host pwrite差异变成覆盖。模式/flags保持在原句柄配额与generation生命周期内。

Linux flags归一化只可忽略明确属于Guest descriptor或regular-file无效的`O_NOCTTY/O_NONBLOCK/O_LARGEFILE/O_CLOEXEC`；`O_NOFOLLOW/O_DIRECTORY/O_SYNC/O_PATH`及未知bits在未实现精确语义前拒绝，不可默默抹掉。此open分支不增加公开numeric flags支持；ACCESS、fsync与目录durability由H.2独立注册，不可从open flag推断已授权。

path v1只接受canonical `holo-fs://<rootId>/<segments>` string，经附录B canonicalize；Guest URL object、subclass/Proxy/fake URL、相对/原生/file URL拒绝。这样snapshotter无需读取URL exotic internal slot或可替换getter。Host将rootId映射到真实目录，映射只存在Provider authority，不进Context/CDP/log/error。mode v1只允许省略；数字mode返回unsupported。

旧品牌前缀的FS scheme必须在v1发布前原子迁移为`holo-fs://`，同步Policy、Facade、Provider、digest和vectors；不得长期接受两个scheme形成权限alias。

## H.3 Guest objects

callback/sync `open` 返回非负 virtual fd，实际由 Guest facade table 映射 Bridge opaque handle；Guest 猜测/复用 fd不能伪造资源。Promise `open` 返回 Guest Realm `FileHandleV1`：

```ts
interface FileHandleV1 {
  readonly fd: number
  readFile(
    options?: FsReadFileAsyncOptionsV1
  ): Promise<RuntimeBufferV1 | string>
  writeFile(
    data: string | Uint8Array,
    options?: FsWriteFileAsyncOptionsV1
  ): Promise<void>
  stat(): Promise<VirtualStatsV1>
  utimes(atime: FsPublicTimeV1, mtime: FsPublicTimeV1): Promise<void>
  truncate(len?: number): Promise<void>
  sync(): Promise<void>
  datasync(): Promise<void>
  chmod(mode: FsModeInputV1): Promise<void>
  close(): Promise<void>
}
interface VirtualStatsV1 {
  readonly size: number
  readonly mode?: number
  readonly atimeMs?: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly birthtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}
interface VirtualDirentV1 {
  readonly name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}
```

size是非负safe integer bytes；Ms是Unix epoch有限数（atime/mtime/ctime允许负值），birthtimeMs保持非负。H.2的精确Ns是Host-only snapshot字段，不投影为普通Guest Stats的string属性；`bigint:true`尚未支持。Objects 在 Guest Realm 重建，方法是 facade wrapper；无 native fd/path/prototype。lstat 可报告 symlink；Policy symlinks=deny 时访问终止，withinRoot 时按附录 B.1 challenge。

## H.4 Semantics

- readFile/writeFile 是 all-or-error；decoded/encoded bytes计入同一 quota。`w/wx` 使用 Provider `fs.atomic-write` staged resource，commit 原子替换；cancel/failure/close 回滚。append 在 target identity 上序列化，单次 append 原子。
- rename 仅同 root，原子替换遵循 Node EEXIST/ENOENT contract；跨 root 固定 EXDEV。unlink 只删 file/symlink；directory 使用 unsupported。
- mkdir recursive=false 创建单层；true 创建缺失层并返回首个 created virtual path或 undefined。
- readdir name按 Provider snapshot排序；`withFileTypes`返回 VirtualDirent；entries/bytes有界。
- watch返回generation-bound watcher。event=`rename|change`、filename是相对canonical segment或null；Provider sequence严格递增、overflow产生E.1 `resource.event_limit`→`ENOSPC` terminal，close exactly-once。FSWatcher/Promise watch精确接口见H.1；v1不声称跨平台逐事件完全等价。
- fd/FileHandle rights从 open flag导出并绑定 invocation/resource；close 后 EBADF。所有 I/O在执行前重验 root/rights/generation。

## H.5 验收

共享 vectors 覆盖 options/flags/encoding、virtual path、Stats/Dirent/FileHandle、atomic rollback、append ordering、rename EXDEV、symlink challenge、TOCTOU、quota/Abort/old fd、watch ordering/close/overflow和全部unsupported exports。M3 的 Node/Desktop 与 Android emulator E2E 必须覆盖 read、write、open-handle、stat/lstat、readdir/mkdir、rename/unlink、watch及同步/callback/promise代表入口，不能只用 read 宣称 Provider 完成。M2.5 只验证一个受控读与一个受控写的安全能力内核纵向切片，不得据此声明完整FS Provider。
