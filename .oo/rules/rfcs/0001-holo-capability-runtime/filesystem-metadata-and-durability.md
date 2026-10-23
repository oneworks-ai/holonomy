# RFC-0001 附录 H.2：FS Metadata 与 Durability

[返回 Filesystem Registry](filesystem-operation-registry.md)

MODE/chmod与独立权限见[H.3](filesystem-mode.md)。

本表扩展 H.1 的单一 Registry。所有 public mutation/sync/access 均返回 void；内部 readback branch 不改变 Node 公开返回值。`fs`=node:fs，`fs/promises`=node:fs/promises。

| Module/member           | Mode     | Args / result                                      | Operation/right                           | callback |
| ----------------------- | -------- | -------------------------------------------------- | ----------------------------------------- | -------- |
| fs/utimesSync           | sync     | FsUtimesArgsV1 / void                              | filesystem.metadata.utimes / write        | —        |
| fs/utimes               | callback | FsUtimesArgsV1 / void                              | filesystem.metadata.utimes / write        | void     |
| fs/promises/utimes      | promise  | FsUtimesPromiseArgsV1 / FsMutationResultV1         | filesystem.metadata.utimes / write        | —        |
| fs/futimesSync          | sync     | FsHandleTimesArgsV1 / void                         | filesystem.metadata.utimes / handle-write | —        |
| fs/futimes              | callback | FsHandleTimesArgsV1 / void                         | filesystem.metadata.utimes / handle-write | void     |
| FileHandle/utimes       | promise  | FsHandleTimesPromiseArgsV1 / FsMutationResultV1    | filesystem.metadata.utimes / handle-write | —        |
| fs/truncateSync         | sync     | FsTruncateArgsV1 / void                            | filesystem.file.truncate / write          | —        |
| fs/truncate             | callback | FsTruncateArgsV1 / void                            | filesystem.file.truncate / write          | void     |
| fs/promises/truncate    | promise  | FsTruncatePromiseArgsV1 / FsMutationResultV1       | filesystem.file.truncate / write          | —        |
| fs/ftruncateSync        | sync     | FsHandleTruncateArgsV1 / void                      | filesystem.file.truncate / handle-write   | —        |
| fs/ftruncate            | callback | FsHandleTruncateArgsV1 / void                      | filesystem.file.truncate / handle-write   | void     |
| FileHandle/truncate     | promise  | FsHandleTruncatePromiseArgsV1 / FsMutationResultV1 | filesystem.file.truncate / handle-write   | —        |
| fs/fsyncSync            | sync     | FsSyncArgsV1 / void                                | filesystem.file.sync / handle             | —        |
| fs/fsync                | callback | FsSyncArgsV1 / void                                | filesystem.file.sync / handle             | void     |
| FileHandle/sync         | promise  | EmptyArgsV1 / void                                 | filesystem.file.sync / handle             | —        |
| fs/fdatasyncSync        | sync     | FsSyncArgsV1 / void                                | filesystem.file.datasync / handle         | —        |
| fs/fdatasync            | callback | FsSyncArgsV1 / void                                | filesystem.file.datasync / handle         | void     |
| FileHandle/datasync     | promise  | EmptyArgsV1 / void                                 | filesystem.file.datasync / handle         | —        |
| fs/accessSync           | sync     | FsAccessArgsV1 / void                              | filesystem.metadata.access / access       | —        |
| fs/access               | callback | FsAccessArgsV1 / void                              | filesystem.metadata.access / access       | void     |
| fs/promises/access      | promise  | FsAccessArgsV1 / void                              | filesystem.metadata.access / access       | —        |
| host.fs/directory.open  | promise  | FsDirectoryOpenArgsV1 / FsDirectoryHandleV1        | filesystem.directory.open / list          | —        |
| host.fs/directory.sync  | promise  | FsDirectorySyncArgsV1 / void                       | filesystem.directory.sync / handle        | —        |
| host.fs/directory.close | promise  | EmptyArgsV1 / void                                 | filesystem.directory.close / handle       | —        |

## H.2.1 Normalized schemas

```ts
type FsPublicTimeV1 = number | string
type FsTimeSpecV1 =
  | Readonly<{
    kind: 'set'
    seconds: number
    nanoseconds: number
  }>
  | Readonly<{ kind: 'now' }>
  | Readonly<{ kind: 'omit' }>

interface FsUtimesArgsV1 {
  readonly path: VirtualPathV1
  readonly atime: FsTimeSpecV1
  readonly mtime: FsTimeSpecV1
}
interface FsUtimesReadbackArgsV1 extends FsUtimesArgsV1 {
  readonly readback: true
}
type FsUtimesPromiseArgsV1 =
  | FsUtimesArgsV1
  | FsUtimesReadbackArgsV1
interface FsHandleTimesArgsV1 {
  readonly fd?: number
  readonly atime: FsTimeSpecV1
  readonly mtime: FsTimeSpecV1
}
type FsHandleTimesReadbackArgsV1 = Readonly<{
  atime: FsTimeSpecV1
  mtime: FsTimeSpecV1
  readback: true
}>
type FsHandleTimesPromiseArgsV1 =
  | FsHandleTimesArgsV1
  | FsHandleTimesReadbackArgsV1
interface FsTruncateArgsV1 {
  readonly path: VirtualPathV1
  readonly len: number
}
interface FsTruncateReadbackArgsV1 extends FsTruncateArgsV1 {
  readonly readback: true
}
type FsTruncatePromiseArgsV1 =
  | FsTruncateArgsV1
  | FsTruncateReadbackArgsV1
interface FsHandleTruncateArgsV1 {
  readonly fd?: number
  readonly len: number
}
type FsHandleTruncateReadbackArgsV1 = Readonly<{
  len: number
  readback: true
}>
type FsHandleTruncatePromiseArgsV1 =
  | FsHandleTruncateArgsV1
  | FsHandleTruncateReadbackArgsV1
interface FsSyncArgsV1 {
  readonly fd: number
}
interface FsAccessArgsV1 {
  readonly path: VirtualPathV1
  readonly mode: number
}
interface FsDirectoryOpenArgsV1 {
  readonly path: VirtualPathV1
}
interface FsDirectorySyncArgsV1 {
  readonly dataOnly: boolean
}
interface FsDirectoryHandleV1 {
  readonly binding: Readonly<{
    bindingId: string
    generation: number
  }>
  readonly resourceType: 'filesystem.directory-handle'
  readonly entries: readonly Readonly<{
    name: string
    kind: 'file' | 'directory' | 'symlink'
  }>[]
}
interface FsExactMetadataResultV1 {
  readonly kind: 'file' | 'directory' | 'symlink'
  readonly size: number
  readonly atimeMs: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly birthtimeMs: number
  readonly atimeNs: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}
type FsMutationResultV1 =
  | Readonly<Record<string, never>>
  | FsExactMetadataResultV1
```

Schemas 是 strict own-data JSON snapshot；public `FsPublicTimeV1` 先归一化为 set。仅有限非负秒数或数字字符串可用，Date/Proxy/NaN/Infinity 拒绝，不调用 Guest 转换方法。set.seconds 为0..253402300799整数、nanoseconds 为0..999999999整数；public秒数按ns量化。NOW/OMIT 原样交给 Host `futimens`，仅认证的 Linux source 可提交；不得用 Guest 时钟替代。只有 Linux promise branch可含 `readback:true`，其 result variant 必须为完整 `FsExactMetadataResultV1`；普通 branch 为 void。readback在同一 pinned FD 修改后fstat，不能重新按路径读取替换对象。未知字段与混合非法形态在effect前拒绝。

len是非负safe integer且不超过Policy `maxWriteBytes`，省略时Facade归一化为0；不把超限截断“修正”为较小值。handle mutation要求原句柄write，路径mutation要求对应root.write。只读文件FD也能真实sync/datasync；执行前仍校验root、opaque binding与generation。callback成功精确一参`null`，失败精确一参Error；Promise成功undefined。

Ns是canonical signed decimal（0或非零整数，无leading zero与负零，最多21位数字，负号另计）；Ms为真实有限数，绝对值不超过1e15，birthtimeMs保持非负。共享旧Stats的新增atime/Ns字段可选以兼容旧Provider；Node/Native精确readback与FUSE结果要求完整，不用0代替缺失时间。这是Host JSON形状，Guest Stats仍按H重建方法，不暴露native inode/FD。

ACCESS mode仅0..7；F_OK/R_OK要求read，W_OK要求write，目录R_OK/X_OK走list与实际OS权限，普通file X_OK因无execute authority而拒绝。access是独立检查，不是后续I/O授权；不能先access再绕过正常open准入。

## H.2.2 Directory resource 与 FUSE

三项 `host.fs` directory rows 不是Guest可导入的Node API；仅认证Linux source可调用。open先经Policy与Host Middleware，持有真实pinned目录FD并从同一FD生成有界entries；result经过既有resource publication登记。file+directory共用`maxOpenHandles`总额，entries受`maxDirectoryEntries`与snapshot bytes上限。sync保持Host interception，close为systemOnly/inherited；三者沿同一Registry/Resource生命周期。

FUSE OPENDIR保存opaque binding和entries；READDIR只读已取得的快照；FSYNCDIR按binding同步原FD，不重新打开当前path。RELEASEDIR、VM close、cancel、晚到open和失败publication均释放同一binding，close幂等，旧generation不可继续调用。目录被改名或原路径被替换不能让sync转向新inode；不使用path-only digest代替FD。

FUSE ACCESS/FSYNC/FSYNCDIR先严格校验body、flags、padding与handle/inode；SETATTR仅支持纯size或纯atime/mtime，支持实际NOW组合及FH，SIZE可带LOCKOWNER但无锁语义。size+times、MODE/UID/GID/CTIME与未知bits整单返回Linux errno 95，不先部分修改；这是FUSE wire errno而非Guest Error.code。FLUSH仅确认已await的写入/句柄状态，不等于fsync，不承诺durability。Host OS失败、取消和mutation后readback失败不承诺磁盘回滚，也不自动重试mutation。

标准API语义参考[Node FS](https://nodejs.org/docs/latest-v22.x/api/fs.html)，FUSE关闭/同步边界参考[libfuse low-level contract](https://libfuse.github.io/doxygen/structfuse__lowlevel__ops.html)。新增rows的实际平台support只能由同一schema、最低层vectors与真实Guest运行声明，不由本Proposed合同直接宣布通过。
