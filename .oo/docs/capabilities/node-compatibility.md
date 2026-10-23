# Node 兼容模块

[English](../en/capabilities/node-compatibility.md)

Holonomy 提供受限、冻结且不依赖 ambient Node global 的兼容模块。它不是完整 Node.js。

| 模块                   | 状态 | 主要范围                                              |
| ---------------------- | ---- | ----------------------------------------------------- |
| `node:buffer`          | 🟡   | 创建、UTF-8/base64/base64url/hex、切片、比较          |
| `node:events`          | 🟡   | 常用 EventEmitter 注册、移除、触发与 error event      |
| `node:path`            | 🟡   | POSIX 路径；无 `path.win32`                           |
| `node:url`             | 🟡   | `URL`、`URLSearchParams`；有限 file URL 转换          |
| `node:os`              | 🟡   | 启动时冻结的受限平台快照                              |
| `node:process`         | 🟡   | argv/env/cwd/platform/stdio、nextTick；无任意进程控制 |
| `node:stream`          | 🟡   | 内存 Readable/Writable/Duplex/Transform/Pipeline      |
| `node:stream/promises` | 🟡   | `pipeline`、`finished` 子集                           |
| `node:stream/web`      | 🟡   | 默认 WHATWG stream constructors                       |
| `node:console`         | 🟡   | 有界 Console API                                      |
| `node:timers`          | 🟡   | timeout/interval、Immediate；非完整 libuv 相位语义    |
| `node:test`            | 🟡   | 顺序 runner、before/after/beforeEach/afterEach        |
| `node:assert/strict`   | 🟡   | conformance 使用的严格断言子集                        |

Guest 不获得宿主 `require`、真实宿主 `process`、真实宿主 `Buffer` 或系统 `fetch`。所有模块来自 Runtime 的 synthetic registry。

`Buffer.alloc(size, fill?, encoding?)` 支持数值、字符串和 `Uint8Array` 填充，以及上述 UTF-8/hex/base64/base64url 编码；不把普通对象、其他 TypedArray 或未知编码静默当作零填充。`allocUnsafe` 仍采用安全的零初始化；没有承诺完整 Node 隐式类型转换。

显式 FS Policy 与 Provider 启用后，macOS Native/Node 还提供 `utimes/futimes`、`truncate/ftruncate`、`fsync/fdatasync`、`access` 的受控 sync/callback/Promise 或 FileHandle 入口。时间输入限非负有限秒数/十进制字符串，Date 与 `bigint:true` 尚不支持；普通 Stats 不暴露 Host 纳秒字符串。只读句柄可同步，修改仍受独立权限与字节上限约束。此增量没有 Android 设备验收，也不是完整 POSIX/Node FS。

组合 Runtime 的 `process.nextTick` 与已有 Event Loop 共用一个队列，不向 Host 序列化回调或参数。CJS/ESM 入口与 Promise 的优先级分别验证，递归回调受预算约束；原始 Node Core factory 若未注入本地调度器仍明确不支持。组合 Runtime 的全局和 `node:timers` 同时提供 `setImmediate`/`clearImmediate`、句柄引用控制及有界批次；原始 timer factory 仍只拥有 timeout/interval。新增证据来自 macOS Native 与 Node，不是 Android 设备验收，也不代表完整 Node/libuv I/O 相位兼容。

`node:assert/strict` 的 `throws/rejects` 支持错误对象字段、正则、构造器和必须返回字面量 `true` 的校验函数；不会忽略错误码匹配。成功返回值分别为 `undefined` 和兑现为 `undefined` 的 Promise；`rejects` 不接受普通 thenable。Native/Node 使用引擎内部 Promise 品牌检查，不调用 Guest 的 `then` getter。常见 Date、RegExp、Map、Set 与二进制内建对象按内容比较，不以“没有自有键”判为相等；这仍不是完整 Node 深比较兼容声明。

macOS Native/Node 的 `chmod/fchmod` 需要 Host 在虚拟 root rights 中另外授予 `chmod`，普通 write 或持有 FD 不隐含该权限。支持 sync/callback/Promise/FileHandle，mode限0..0777或仅0–7数字组成的八进制字符串；不接受special bits、filetype bits或`0o644`字符串。Stats.mode反映真实type/permission；readonly数据FD在独立批准元数据权后可改mode，但仍不能写数据。无可安全打开FD的mode000 path可能保守拒绝，原FD可恢复mode000。

共享 Loader 已支持 `package.json#imports` 的包内别名、模式和条件，并按精确目标解析；裸内建名称只别名到 Host 已声明的 `node:*` 绑定。独立 Native 的实体依赖树和目录诊断限制见[平台说明](../platforms/native/index.md)。

已启用 FS 的 Native Runtime 会在本地 Event Loop 任务中投递 error-first callback：回调内的 `process.nextTick` 先于 Promise job；成功、失败和 void callback 保持各自实参数量，回调抛错进入 Runtime 的未捕获错误边界。Promise API 的顺序不变。这是受限回调行为的验证，不是完整 Node/libuv 相位兼容或 Android 设备验收。

权威细粒度矩阵位于源码 `packages/runtime/src/node-compat/capabilities.ts` 与 `packages/runtime/src/streams/capabilities.ts`；本页只维护用户需要的稳定摘要。
