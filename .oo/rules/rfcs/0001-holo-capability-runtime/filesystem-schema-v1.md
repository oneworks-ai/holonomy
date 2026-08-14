# RFC-0001 附录 H：`node:fs` Sandbox v1

[返回 RFC 总览](../0001-holo-capability-runtime.md)

v1 是明确的 production 子集，不声称实现全部 Node FS。未列为 supported 的 export 由 Synthetic Module 缺失导出或稳定 `ERR_METHOD_NOT_IMPLEMENTED` 表达，永不回退 ambient `node:fs`。

每个supported export/overload的args/result/callback tuple/right/syscall由[附录 H.1](filesystem-operation-registry.md)唯一冻结；本页matrix只做能力导航。

## H.1 Capability matrix

| Operation family                               | `node:fs` sync       | callback            | `node:fs/promises`        | v1                           |
| ---------------------------------------------- | -------------------- | ------------------- | ------------------------- | ---------------------------- |
| readFile/writeFile                             | `*Sync`              | functions           | functions                 | supported                    |
| open/close                                     | `openSync/closeSync` | functions           | `open`+FileHandle.close   | supported                    |
| stat/lstat                                     | `*Sync`              | functions           | functions/FileHandle.stat | supported                    |
| readdir/mkdir                                  | `*Sync`              | functions           | functions                 | supported                    |
| rename/unlink                                  | `*Sync`              | functions           | functions                 | supported                    |
| watch                                          | `watch` resource     | `watch` listener    | `watch` AsyncIterable     | partial, same event contract |
| fd/FileHandle readFile/writeFile               | methods/input fd     | functions accept fd | FileHandle methods        | supported                    |
| partial read/write/readv/writev                | exports              | exports             | FileHandle methods        | unsupported                  |
| streams/Dir/opendir                            | exports              | exports             | exports                   | unsupported                  |
| realpath/readlink/symlink/link                 | exports              | exports             | exports                   | unsupported                  |
| chmod/chown/utimes/truncate/copy/cp/rm/mkdtemp | exports              | exports             | exports                   | unsupported                  |

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
```

Read/write/readdir/mkdir options 会随sync/async参数选择结果或取消语义，全部由附录 H.1 唯一定义，避免导航页与 Operation Registry 重复 owner。

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
  close(): Promise<void>
}
interface VirtualStatsV1 {
  readonly size: number
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

size/times 是非负 safe number（bytes/Unix epoch ms）。Objects 在 Guest Realm 重建，方法是 facade wrapper；无 native fd/path/prototype。lstat 可报告 symlink；Policy symlinks=deny 时访问终止，withinRoot 时按附录 B.1 challenge。

## H.4 Semantics

- readFile/writeFile 是 all-or-error；decoded/encoded bytes计入同一 quota。`w/wx` 使用 Provider `fs.atomic-write` staged resource，commit 原子替换；cancel/failure/close 回滚。append 在 target identity 上序列化，单次 append 原子。
- rename 仅同 root，原子替换遵循 Node EEXIST/ENOENT contract；跨 root 固定 EXDEV。unlink 只删 file/symlink；directory 使用 unsupported。
- mkdir recursive=false 创建单层；true 创建缺失层并返回首个 created virtual path或 undefined。
- readdir name按 Provider snapshot排序；`withFileTypes`返回 VirtualDirent；entries/bytes有界。
- watch返回generation-bound watcher。event=`rename|change`、filename是相对canonical segment或null；Provider sequence严格递增、overflow产生E.1 `resource.event_limit`→`ENOSPC` terminal，close exactly-once。FSWatcher/Promise watch精确接口见H.1；v1不声称跨平台逐事件完全等价。
- fd/FileHandle rights从 open flag导出并绑定 invocation/resource；close 后 EBADF。所有 I/O在执行前重验 root/rights/generation。

## H.5 验收

共享 vectors 覆盖 options/flags/encoding、virtual path、Stats/Dirent/FileHandle、atomic rollback、append ordering、rename EXDEV、symlink challenge、TOCTOU、quota/Abort/old fd、watch ordering/close/overflow和全部unsupported exports。M3 的 Node/Desktop 与 Android emulator E2E 必须覆盖 read、write、open-handle、stat/lstat、readdir/mkdir、rename/unlink、watch及同步/callback/promise代表入口，不能只用 read 宣称 Provider 完成。M2.5 只验证一个受控读与一个受控写的安全能力内核纵向切片，不得据此声明完整FS Provider。
