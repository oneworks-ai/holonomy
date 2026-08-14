# RFC-0001 附录 H.1：`node:fs` Operation Registry

[返回 Filesystem Sandbox](filesystem-schema-v1.md)

```ts
type FilesystemOperationV1 =
  | 'filesystem.file.read'
  | 'filesystem.file.write'
  | 'filesystem.file.open'
  | 'filesystem.file.close'
  | 'filesystem.metadata.stat'
  | 'filesystem.metadata.lstat'
  | 'filesystem.directory.read'
  | 'filesystem.directory.create'
  | 'filesystem.entry.rename'
  | 'filesystem.entry.unlink'
  | 'filesystem.watch.subscribe'
  | 'filesystem.watch.close'

type FsPathOrFdV1 = VirtualPathV1 | VirtualFdV1
interface VirtualFdV1 {
  readonly fd: number
  readonly binding: 'opaque'
}
type FsDataV1 = string | Uint8Array
```

Facade只把Guest non-negative safe integer fd解析成generation-bound `VirtualFdV1` Host snapshot；number本身不是authority。URL/Buffer path、native fd/path和未列overload拒绝。fd read/write不关闭句柄；FileHandle method从自身opaque binding取resource。

## H.1.1 Argument-selected result Schema

```ts
type FsReadFileSyncOptionsV1 =
  | Readonly<{ encoding?: null; flag?: 'r' }>
  | Readonly<{
    encoding: 'utf8' | 'utf-8' | 'base64' | 'hex'
    flag?: 'r'
  }>
type FsReadFileAsyncOptionsV1 =
  | Readonly<{ encoding?: null; flag?: 'r'; signal?: AbortSignal }>
  | Readonly<{
    encoding: 'utf8' | 'utf-8' | 'base64' | 'hex'
    flag?: 'r'
    signal?: AbortSignal
  }>
type FsReadFileOptionsV1 =
  | FsReadFileSyncOptionsV1
  | FsReadFileAsyncOptionsV1
type FsReadResultV1<O extends FsReadFileOptionsV1 | undefined> = O extends
  { encoding: Exclude<FsEncodingV1, null> } ? string
  : RuntimeBufferV1

interface FsWriteFileSyncOptionsV1 {
  readonly encoding?: Exclude<FsEncodingV1, null>
  readonly flag?: 'w' | 'wx' | 'a' | 'ax'
}
interface FsWriteFileAsyncOptionsV1 extends FsWriteFileSyncOptionsV1 {
  readonly signal?: AbortSignal
}

type FsReaddirOptionsV1 =
  | Readonly<{ encoding?: 'utf8' | 'utf-8'; withFileTypes?: false }>
  | Readonly<{ encoding?: 'utf8' | 'utf-8'; withFileTypes: true }>
type FsReaddirResultV1<O extends FsReaddirOptionsV1 | undefined> = O extends
  { withFileTypes: true } ? VirtualDirentV1[] : string[]

type FsMkdirOptionsV1 =
  | Readonly<{ recursive?: false }>
  | Readonly<{ recursive: true }>
type FsMkdirResultV1<O extends FsMkdirOptionsV1 | undefined> = O extends
  { recursive: true } ? VirtualPathV1 | undefined : undefined
type FsMkdirRecursiveResultSnapshotV1 =
  | Readonly<{ kind: 'path'; value: VirtualPathV1 }>
  | Readonly<{ kind: 'undefined' }>
```

Schema先按arguments选择闭合branch，再冻结对应result与callback delivery；Provider result不能反向改变branch。readFile无options/null encoding→RuntimeBuffer，显式string encoding→string；readdir仅`withFileTypes:true`返回Dirent；mkdir仅`recursive:true`具有第二callback result槽。`FsMkdirRecursiveResultSnapshotV1` 是 Host-side machine snapshot；Facade 将 `kind=undefined` 重建为 Guest `undefined`，不会把tag object暴露给Guest。

## H.1.2 Per-export Registry

| Module/member         | Mode     | Args / result                              | Operation/right                        | callback          |
| --------------------- | -------- | ------------------------------------------ | -------------------------------------- | ----------------- |
| fs/readFileSync       | sync     | PathOrFd,ReadSyncOptions? / ReadResult     | filesystem.file.read / read            | —                 |
| fs/readFile           | callback | PathOrFd,ReadAsyncOptions? / ReadResult    | filesystem.file.read / read            | result branch     |
| fs/promises/readFile  | promise  | PathOrFd,ReadAsyncOptions? / ReadResult    | filesystem.file.read / read            | —                 |
| FileHandle/readFile   | promise  | ReadAsyncOptions? / ReadResult             | filesystem.file.read / handle-read     | —                 |
| fs/writeFileSync      | sync     | PathOrFd,Data,WriteSyncOptions? / void     | filesystem.file.write / write          | —                 |
| fs/writeFile          | callback | PathOrFd,Data,WriteAsyncOptions? / void    | filesystem.file.write / write          | void              |
| fs/promises/writeFile | promise  | PathOrFd,Data,WriteAsyncOptions? / void    | filesystem.file.write / write          | —                 |
| FileHandle/writeFile  | promise  | Data,WriteAsyncOptions? / void             | filesystem.file.write / handle-write   | —                 |
| fs/openSync           | sync     | Path,Flag / VirtualFd                      | filesystem.file.open / flag-rights     | —                 |
| fs/open               | callback | Path,Flag / VirtualFd                      | filesystem.file.open / flag-rights     | result            |
| fs/promises/open      | promise  | Path,Flag / FileHandle                     | filesystem.file.open / flag-rights     | —                 |
| fs/closeSync          | sync     | VirtualFd / void                           | filesystem.file.close / handle         | —                 |
| fs/close              | callback | VirtualFd / void                           | filesystem.file.close / handle         | void              |
| FileHandle/close      | promise  | empty / void                               | filesystem.file.close / handle         | —                 |
| fs/statSync           | sync     | Path,StatOptions? / Stats                  | filesystem.metadata.stat / read        | —                 |
| fs/stat               | callback | Path,StatOptions? / Stats                  | filesystem.metadata.stat / read        | result            |
| fs/promises/stat      | promise  | Path,StatOptions? / Stats                  | filesystem.metadata.stat / read        | —                 |
| FileHandle/stat       | promise  | StatOptions? / Stats                       | filesystem.metadata.stat / handle-read | —                 |
| fs/lstatSync          | sync     | Path,StatOptions? / Stats                  | filesystem.metadata.lstat / read       | —                 |
| fs/lstat              | callback | Path,StatOptions? / Stats                  | filesystem.metadata.lstat / read       | result            |
| fs/promises/lstat     | promise  | Path,StatOptions? / Stats                  | filesystem.metadata.lstat / read       | —                 |
| fs/readdirSync        | sync     | Path,ReaddirOptions? / ReaddirResult       | filesystem.directory.read / list       | —                 |
| fs/readdir            | callback | Path,ReaddirOptions? / ReaddirResult       | filesystem.directory.read / list       | result branch     |
| fs/promises/readdir   | promise  | Path,ReaddirOptions? / ReaddirResult       | filesystem.directory.read / list       | —                 |
| fs/mkdirSync          | sync     | Path,MkdirOptions? / MkdirResult           | filesystem.directory.create / create   | —                 |
| fs/mkdir              | callback | Path,MkdirOptions? / MkdirResult           | filesystem.directory.create / create   | argument variant  |
| fs/promises/mkdir     | promise  | Path,MkdirOptions? / MkdirResult           | filesystem.directory.create / create   | —                 |
| fs/renameSync         | sync     | Path,Path / void                           | filesystem.entry.rename / move         | —                 |
| fs/rename             | callback | Path,Path / void                           | filesystem.entry.rename / move         | void              |
| fs/promises/rename    | promise  | Path,Path / void                           | filesystem.entry.rename / move         | —                 |
| fs/unlinkSync         | sync     | Path / void                                | filesystem.entry.unlink / delete       | —                 |
| fs/unlink             | callback | Path / void                                | filesystem.entry.unlink / delete       | void              |
| fs/promises/unlink    | promise  | Path / void                                | filesystem.entry.unlink / delete       | —                 |
| fs/watch              | sync     | Path,WatchOptions? / FSWatcher             | filesystem.watch.subscribe / watch     | listener contract |
| fs/promises/watch     | sync     | Path,WatchOptions? / AsyncIteratorResource | filesystem.watch.subscribe / watch     | —                 |
| FSWatcher/close       | sync     | empty / void                               | filesystem.watch.close / handle        | —                 |

每row有独立args/result Schema ID；`fs`代表`node:fs`，`fs/promises`代表`node:fs/promises`，FileHandle是`fs/promises.open`返回facade。callback是最后Guest参数且在snapshot前提取。callback result branch使用附录I `result`；void精确`callback(null)`；mkdir recursive false/omitted=`void`，true=`result`，即使result为undefined也保留第二实参。

## H.1.3 Shared options与Watcher

```ts
interface FsStatOptionsV1 {
  readonly bigint?: false
}
interface FsWatchOptionsV1 {
  readonly persistent?: boolean
  readonly recursive?: false
  readonly encoding?: 'utf8' | 'utf-8'
  readonly signal?: AbortSignal
  readonly maxQueuedEvents?: number
}
interface VirtualFsWatchEventV1 {
  readonly eventType: 'rename' | 'change'
  readonly filename: string | null
  readonly sequence: number
}
type VirtualFsWatcherDeliveryV1 =
  | Readonly<{
    event: 'change'
    tuple: readonly ['rename' | 'change', string | null]
  }>
  | Readonly<{ event: 'error'; tuple: readonly [NodeErrorSnapshotV1] }>
  | Readonly<{ event: 'close'; tuple: readonly [] }>

interface VirtualFsWatcherV1 {
  on(
    event: 'change',
    listener: (type: 'rename' | 'change', filename: string | null) => void
  ): this
  on(event: 'error', listener: (error: NodeErrorSnapshotV1) => void): this
  on(event: 'close', listener: () => void): this
  close(): void
}

interface VirtualFsWatchAsyncIteratorV1
  extends AsyncIterableIterator<VirtualFsWatchEventV1>
{
  next(): Promise<IteratorResult<VirtualFsWatchEventV1, undefined>>
  return(): Promise<IteratorResult<VirtualFsWatchEventV1, undefined>>
  throw(
    error?: unknown
  ): Promise<IteratorResult<VirtualFsWatchEventV1, undefined>>
}
```

Stat只支持省略或`bigint:false`。watch `recursive:true`、ref/unref、filename Buffer和其他events unsupported。`fs.watch`同步返回`VirtualFsWatcherV1`；change/error/close按`VirtualFsWatcherDeliveryV1`精确tuple异步投递，close exactly-once且close后无change。listener throw被消费。

`fs/promises.watch`调用同步返回`VirtualFsWatchAsyncIteratorV1`，不会返回`Promise<AsyncIterator>`。`next()`等待下一事件；`return()`原子关闭并返回`{done:true,value:undefined}`，重复调用复用done terminal；`throw()`先关闭，再以E.1 snapshot后的Guest error reject，不能把任意Guest Error传到Host。Abort等同return后的AbortError terminal。overflow以ENOSPC终止FSWatcher error→close或reject pending/future iterator next；terminal后不交付queued event。resource的process/generation/watchId、序列、队列和Policy watcher slot由Kernel绑定，Guest listener/iterator不是authority。

## H.1.4 Machine owner

每row生成module/member、args/result branch、mode、callback tuple、operation/right、resource、syscall、atomicity与limits。watch另生成listener delivery union和iterator `next/return/throw` resource protocol。vectors逐row覆盖read encoding、sync options拒绝signal、readdir withFileTypes、mkdir recursive、sync/callback/promise open形状、fd opaque binding、FileHandle四个methods、void/result `arguments.length`、watch同步返回时序/close/Abort/overflow和unsupported overload；按family抽样不能替代全表。
