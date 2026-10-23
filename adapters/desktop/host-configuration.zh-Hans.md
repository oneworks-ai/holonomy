# 原生 Host 配置

[English](host-configuration.md)

在入口路径之前传入 `--host-config host.json`。Host 提供 Policy 和真实目录安装信息；用户 JavaScript 只看到 `holo-fs://` 虚拟路径及显式选择的 Guest Context 投影。

```json
{
  "schemaVersion": 1,
  "sandboxPolicy": {
    "schemaVersion": 2,
    "filesystem": {
      "access": "sandboxed",
      "roots": [
        {
          "rootId": "workspace",
          "virtualUrl": "holo-fs://workspace/",
          "rights": ["read", "write"],
          "symlinks": "deny"
        }
      ],
      "limits": {
        "maxReadBytes": 4096,
        "maxWriteBytes": 4096,
        "maxOpenHandles": 8,
        "maxWatchers": 0,
        "maxDirectoryEntries": 32,
        "maxQueuedEvents": 0
      }
    }
  },
  "filesystemRoots": [{ "rootId": "workspace", "hostPath": "./data" }],
  "context": { "schemaVersion": 1, "guest": { "application": "example" } }
}
```

先创建 `data` 目录。相对 `hostPath` 以配置文件所在目录解析。重复 root ID、未知字段、不支持的版本和不可用的安装目录会在用户代码执行前失败。配置文件最大 1 MiB，缺省 Policy 字段由共享编译器补为默认拒绝。

```js
import fs from 'node:fs'
fs.writeFileSync('holo-fs://workspace/result.txt', 'native Holonomy')
console.log(fs.readFileSync('holo-fs://workspace/result.txt', 'utf8'))
```

使用 `holo --host-config host.json ./index.mjs` 执行。`readFile`/`writeFile` 的同步、callback 和 Promise 路径进入同一个 Broker。虚拟 fd 和 FileHandle 归当前 generation 所有，关闭后失效。返回或写入字节前会检查额度；`w` 使用原子替换，`wx` 拒绝覆盖已有目标。

可选 `systemProjection` 使用共享的 `{schemaVersion:1, fields:{...}}` 结构；对应 `sandboxPolicy.systemInformation.fields` 必须允许字段模式和精度。Host 与 Inspector 投影保持私有。macOS arm64 可显式[安装 Desktop Device](device.zh-Hans.md)，六项 required API 仍各自受 Device Policy 控制，默认拒绝。Inspector 需另装私有 socket。Process 默认拒绝：macOS 可选择有界的 [Native Darwin profile](process-native-darwin.zh-Hans.md)，或下文独立的实验性 v86 安装。未启用或未授权调用保留共享公开错误。

配置 Host 后，`process.env`、`pid`、`execPath` 在初始 Host 插件装载后、Guest 入口前各准入一次。env 被拒绝时得到冻结空 map；默认/全局对象的 `process.pid`、`process.execPath` 被拒绝时在读取处抛出 `ERR_ACCESS_DENIED`，对应 ESM 命名快照为 `undefined`，其余已获准字段仍可用。`process.cwd()` 每次调用单独准入。`process.versions` 报告 Holonomy 和 V8，不伪造 Node 版本。

Host 可以在 `host.json` 中选择 `"processProfileId": "developer"`，并传入 `--process-profiles /absolute/private/process-profiles.json`。独立清单采用 `{ "schemaVersion": 1, "profiles": { "developer": { ... } } }`，必须是无符号链接、仅所有者可读的普通文件；Guest 无法作为模块读取该清单。只选择 profile 不会激活 `host.process`；未安装的 sandboxed Process Policy 仍会在入口代码执行前失败。

实验性 v86 profile 还需要 `--process-backends /absolute/private/process-backends.json`。这份独立的 Host 私有清单采用 `{ "schemaVersion": 1, "backends": { "experimental.v86-v1": { "implementation": "builtin.v86-v1", "artifactRoot": "/absolute/verified-assets" } } }`。所选 Backend ID 必须与 profile 一致；资产根必须由所有者控制且没有符号链接别名。Rust 仍会按 profile 摘要复核每件安装资产；仅有这份配置不会启用 Process Policy。

仅供开发验证的 `--experimental-v86-process` 会在两份清单通过选择后增加私有 Host 激活位。SandboxPolicy、Process capability 准入和 Rust 资产检查仍然适用。真实原生 Guest 的 `spawn('cat')`、`execFile`、受控 shell，以及按进程归因并可被插件拒绝的 FUSE Host 读写均已通过。FUSE 要求单个 `/workspace` mount、安装的 `fuse` 内核能力，同时受 Process mount 权限和普通 FS Policy 权限约束。显式 restricted Process 网络可使用[有界 TCP/UDP、Host DNS 和 curl HTTP 代理](process-v86-network.zh-Hans.md)；普通 JS Fetch Policy 不会被扩大。受限 FUSE 用例已覆盖 ACCESS、文件/目录 fsync、元数据、chmod 和 Git init/status；完整 POSIX/Git、TLS/地址族和后代进程接受度仍未完成。默认 CLI 继续拒绝 Process，此开关不构成广泛支持声明。

rename 要求 root 的 `move` 权限；源和目标分别经过共享资源准入，并绑定一次性身份凭据。跨 root 返回 `EXDEV`，源文件或父目录在准入后被替换会拒绝提交。

watch 要求 `watch` 权限，以及大于零的 `maxWatchers`、`maxQueuedEvents`。macOS 使用 kqueue 监听已打开的目标与直接子项，目录变化通过有界快照补充文件名；不启用递归。`fs/promises.watch()` 同步返回 AsyncIterator，队列溢出以 `ENOSPC` 结束，Abort/close 会释放资源。`persistent:false` 不阻止进程退出。底层事件可以合并，不能假定每次写入都对应一次通知；监听目标本身被删除、重命名或撤销时发送错误后关闭。原子替换文件的场景宜监听其父目录。

默认 `symlinks: deny` 拒绝 symlink，写入和 unlink 目标也适用。显式设置 `symlinks: withinRoot` 可在同一安装根内解析有界链接，对解析后的资源重新执行 Policy/Broker 准入，并保留精确的原生描述符。Guest 不会得到真实路径。

withinRoot 子集支持读取、stat、readdir、open/FileHandle、文件与目录 watch，以及有界的独占创建和已准入句柄写入。watch 订阅已准入的文件或目录描述符；准入后路径或 symlink 被替换，也不会把 watch 转向另一个 inode。既有可写文件先以不截断方式打开并核对身份；缺失目标使用已准入的父目录句柄和独占创建，并发出现的新文件不会被覆盖。句柄是对象能力：对象后续被改名，不会让句柄转而指向同名的另一个 inode。

withinRoot 的 lstat 支持普通文件和目录，包括经根内父目录 symlink 访问的对象；末级 symlink（根内、根外或损坏链接）仍返回 `provider.unavailable`，不会跟随链接或返回链接目标元数据。lstat 从验证后固定的描述符读取；验证前身份变化会拒绝，验证后路径替换仍只读取原对象。

withinRoot 的 rename、unlink、替换已有目标的原子写，以及多层父目录缺失的 recursive mkdir 暂不支持并明确拒绝。特别是默认原子 `writeFile` 不能在此 profile 中替换已有文件；适合时可通过明确准入的可写 FileHandle 操作。文件 watch 监听原 inode；该 inode 被删除、改名或撤销时，会发出错误并关闭；文件路径可能被原子替换时，应监听父目录。这些限制不影响既有 deny profile。最多保留 64 个解析票据，失败或取消会释放描述符。

原生读写另有 8 MiB 硬上限，请求 JSON 最大 1 MiB。watch 另有 1024 个 watcher、4096 个底层 vnode 订阅的 Host 上限。

所选 v86 profile 可独立开启供 `hoholo` 使用的 [Device/System 领域](process-v86-capabilities.zh-Hans.md)。领域本身不授予权限：仍需 Host Device 安装、字段 Policy/投影，并经过相同插件。这是一次性读取，不是 Linux 事件订阅或原始 Host OS 回退。

## HTTP(S) 与 Mock

`sandboxPolicy.network` 接受共享的 `none`、`mockOnly`、`restricted` 结构。以下示例合入 `sandboxPolicy`：

```json
{
  "network": {
    "access": "restricted",
    "allowedOrigins": ["https://example.org"],
    "allowedSchemes": ["https"],
    "allowPrivateNetwork": false,
    "limits": {
      "maxUrlBytes": 4096,
      "maxHeaders": 32,
      "maxHeaderBytes": 16384,
      "maxRequestBodyBytes": 1048576,
      "maxResponseBodyBytes": 1048576,
      "maxChunkBytes": 65536,
      "maxConcurrentConnections": 4,
      "maxRedirects": 0,
      "socketTimeoutMs": 5000
    },
    "requestBodyInspection": { "access": "none" }
  }
}
```

Guest 使用标准 `fetch()`。每一跳重定向重新准入，`maxRedirects:0` 合法。DNS 检查全部解析地址并固定已准入的地址；私网必须显式允许。HTTPS 校验证书和原始 hostname；可选顶层 `networkTrustRoots` 最多添加 8 个 PEM 证书，每个不超过 64 KiB，不关闭 TLS 验证，也不读取环境代理。

顶层 `networkRules` 使用现有 Network Rules schema，保留在 Host Context；`mockOnly` 不会退回真实 I/O。Abort 可取消准入/预解析及传输，响应上限和超时保留公开 Network 错误。`fetch()` 在响应头校验后返回，正文通过原有 Bridge credit 逐块读取，每个下游 credit 最多触发一次有界上游 pull。clone 共用一个上游；最后一个 reader 取消时关闭上游并释放连接槽。已经取消或关闭的调用不能再发布已排队的 head/chunk，也不能复活流。

`socketTimeoutMs` 约束 DNS/响应头工作和每次实际正文读取，不把调用方主动不发 credit 的空闲时间算作网络超时。请求正文仍在 I/O 前暂存；请求和响应保留 8 MiB 原生硬上限，响应分块遵守 `maxChunkBytes`。只保留尚未读取的 body 不会单独阻止 Runtime 退出。此原生目标尚不启用请求上传流、WebSocket、任意 TCP/UDP。

### Host-only 请求正文检查

需要两次显式配置：Network Policy 设置 `requestBodyInspection: { "access": "bounded", "maxBytes": 4096, "maxReadsPerRuntime": 16 }`，顶层再设置 `networkRequestBodyReader: { "capabilityName": "host.network.request-body.read", "maxReadBytes": 4096, "maxReads": 16 }`。Host 选择独立 capability，Kernel 复核其 Policy、进程和 generation 绑定，再取所有限制的交集。Policy 为 `none` 时配置 reader 无效；未选择 reader 时插件只能看到 metadata。

可信插件可在 `network.fetch.request` 拦截器中通过 `request.hostBindings?.find(binding => binding.kind === 'networkRequestBodyReader')` 取得 reader。`await reader.read()` 返回一次独立字节副本；可选 `{maxBytes}` 只返回前缀，第二次读取失败。reader 不是 JSON 参数、Provider 续接权限或 Guest API；原始正文不进入可序列化调用 metadata、Observer 或普通诊断。

未选择 reader 时，Guest hook 不编码额外检查副本，Rust 也会在正文进入 Host owned queue 前省略它。启用后，Rust 在复制前复核冻结的 Host 上限，并在释放时清零自有传输字符串；V8 不可变字符串与可信插件自行保存的其他副本不保证清零。

完整正文必须小于等于 Policy、capability 与 1 MiB Host 上限的最小值。最多保留 `min(maxReads, 64)` 个存活 reader、合计 1 MiB 检查正文；额度不足时省略 reader，不因此拒绝普通 Fetch。存活副本最多再占 1 MiB。拒绝、取消、完成、重启或请求的 `socketTimeoutMs` 期限到达后撤销 reader，并尽力清零保留的正文与副本；未返回的异步检查插件也受该期限约束。可信插件仍能主动复制数据，因此清零不是针对 Host 插件的保密边界。

## 初始 Cordis 插件

Host 配置增加 `plugins` 数组。元素包含稳定 `id`、`use`，以及可选 `config`、`enabled`、`export`（默认 `default`）、`integrity`（bundle SHA-256）。相对路径（含 `../`）按配置文件目录解析；包名沿其 `node_modules` 祖先目录查找。绝对路径额外要求顶层 `pluginRoots` 白名单。包的 `package.json` 必须声明 `holo: {kind: "runtime-plugin", apiVersion: 1, entry: "./index.mjs"}`。

```json
{
  "plugins": [{ "id": "deny-arch", "use": "./plugins/deny.mjs" }],
  "pluginRoots": ["./trusted-packages"]
}
```

示例 `plugins/deny.mjs`：

```js
export default ctx => {
  ctx.holo.intercept(
    { operation: 'system.os.arch.read' },
    invocation => ctx.holo.deny(invocation),
    { execution: 'sync' }
  )
}
```

当 System Policy 本来允许该操作时，此插件会拒绝 `node:os.arch()`；Policy 始终是硬上限。Host 插件是可信 JavaScript 扩展，不是 Guest 程序，只启用可信包。完整不可变 ESM 图以 `holo-plugins:///` 准入，Cordis 全部安装完成后才执行 Guest；非法 import、摘要不符或插件初始化失败都会阻止入口。私有子进程启动重新核对根目录 device/inode，symlink 或根目录替换都会拒绝。

当前支持有界、完整快照的纯 JS ESM 包图，包括包内相对依赖、受支持的 `exports`/`imports` 和相对 `node_modules` 包链接仍位于配置根内的 pnpm 安装。可以用包目录或 `package.json` 路径作为入口；绝对来源必须显式选择 `pluginRoots`。裸插件包入口不接受子路径。父目录实体包保留严格 nofollow 查找；根外链接、普通文件符号链接、Node/native import 和未闭合的外部依赖仍拒绝。依赖超出该子集时，应先构建自包含 ESM 产物；这不代表完整 npm 兼容。`runtimePlugins`、`runtimePluginRoots`、`privateSources` 属于私有启动字段，公开 Host 配置会拒绝它们。

Native CLI 用同一个固定包根描述符读取 manifest、Schema 和包内模块；配置 watch 继续使用同一源码角色账本。包的请求别名与实际文件身份在重定向后仍保持私有；Schema 无效或将 Guest 源提升为 Host 插件时，保留上一版可用图。每个读取器会话最多 128 个包租约、512 个不同包资源，总大小高水位 32 MiB；相同内容重读不新增资源计数。配置/token 及包内叶文件仍不跟随链接。这不是源文件 HMR，也不代表完整 npm 依赖解析。

Guest 模块读取器拒绝实际 Host 配置文件及已准入的 Host 插件入口、显式选择的 manifest、Schema 和代码依赖。描述符的 device/inode 身份覆盖硬链接和 URL 别名；修改 `sourceURL` 不会取得权限。普通 Guest JSON 模块及同目录中互不相同的 Host/Guest 文件仍可使用。强私有文件不能同时用于两域；watch 候选尝试使用 Guest 已读模块也会拒绝。全部候选图准备完成后才执行候选插件；拒绝更新保留旧图，也保留此前已识别的私有文件身份。

一个受限例外是共享的包作用域元数据：本地 Host 插件和 Guest `index.js` 可以由可信 Loader 使用同一份 `package.json` 判断模块类型和包解析。仅作为 Host 包元数据读取的文件不会因此变成 Guest 可导入的 JSON；直接 require/import、缓存命中及别名请求仍需独立源码准入。显式私有 manifest、配置和 Schema 不适用此例外。没有 Host 限制的普通 Guest `package.json` 保持既有 JSON 行为；原始字节不会被改写或删字段。

受管 Native CLI 在收集 Guest 模块前保留自己选定的完整 Service home 目录。因此，即使该目录位于项目内，其中的状态、配置和控制面文件也不能作为 Guest 模块读取；已固定目录改名后的别名仍受检查。这不自动保护任意操作系统目录，也不限制 Host 有意发布的数据或显式授予的 FS API 权限。

源码准入在 Runtime 生命周期内保留文件身份、逻辑私有路径及固定父目录的私有目录项，合计最多 4,096 条记录，常驻描述符也不超过此数。Guest 在打开文件前拒绝已知私有路径，因此替换祖先目录不能绕过；最后一次 descriptor-relative open 前还会检查固定父目录中的私有文件名。macOS 使用保守的大小写不敏感与 Unicode 规范等价比较，因此在大小写敏感卷上也可能拒绝与私有名只存在大小写差异的另一文件。其他 Unix 目标按名称字节精确比较，要求文件系统采用大小写敏感查找。普通同目录文件仍可读取。私有启动绑定在子进程重新验证；长期重复替换可能耗尽额度，此时需要重启。

读取器同时观察逻辑私有路径及固定目录项当前指向的文件；根外配置目录被替换后，当前配置的硬链接也会受到保护。该观察不是原子文件系统事务，也不是拒绝直接私有路径的依据，不能冻结外部 writer 在查找期间轮换未观察对象或硬链接别名。任意外部 writer 可以把从未被观察的新秘密短暂放在私有路径，再移走或复制到 Guest 文件名，并在 Host 观察前清除当前证据；POSIX inode 检查无法恢复这段历史。因此 Host 发布流程必须将未登记的临时文件、备份及搬移/复制的秘密留在 Guest 资源命名空间之外，并串行协调新别名的发布；更强的任意外部 writer 信息流隔离需要操作系统隔离或受控发布。已登记的私有文件身份在改名和硬链接后仍受保护。该边界只约束模块加载：Host 显式授予的文件系统权限仍可能通过 FS API 暴露文件，Host 必须避免授权访问自己的秘密。

包可以增加 `holo.configSchema: "./schema.json"`。Schema 从包根目录内读取快照，不跟随符号链接，并在 Guest 入口或插件发布前校验。Native 与 Node 使用同一锁定的 Ajv2020：严格编译、不验证 format、不强制转换类型、不删除未知字段、不注入 default。支持 boolean schema 和本地 `$defs`/`$ref`；无法解析的外部引用直接失败，不会联网读取。

原生校验只在可丢弃的私有 `holo` helper 中执行，不进入运行中的 Host/Guest isolate。Schema 文件最多 1 MiB，Schema/config 合并输入最多 2 MiB；校验采用从 helper 启动前计时的 750 ms 截止预算，V8 heap 32 MiB，macOS 另轮询 256 MiB RSS 上限。OS 启动若阻塞，会在返回后检查截止时间并拒绝过期结果；这不是整个 CLI 启动耗时的承诺。RSS 是轮询监测，不是内核内存预留。超时、崩溃或非法配置只拒绝候选，错误不含 Schema 内容或真实路径。watch 异步等待校验，现有调用和 Gate 取消继续推进；上一版插件图保持可用，后续有效配置可以恢复。这些限制可能拒绝语义合法但计算成本过高的 Schema。

## 插件配置 watch

```sh
holo --watch --host-config ./holo.config.json ./index.mjs
```

`--watch` 保持 Runtime 存活并观察显式指定的 Host 配置文件，仅用于 `run`，不用于 `test`，且必须配合 `--host-config`。它不重新执行 Guest 入口，也不是任意源码文件 HMR。修改 `plugins` 数组会请求候选图，重新读取完整模块图（含相对依赖）；只修改源码文件不触发重载。

插件 ID 在替换前后保持稳定；未变实例保留，变更/移除实例在其在途能力调用结束后由 Cordis dispose。每个模块及依赖都绑定 bundle 版本，动态 import 始终使用发起它的原图。失败候选保留上一版。一次只有一个更新在途，后续配置修改在其完成后再处理。Policy、根目录白名单、投影、Network Rules 及所有非插件字段在本 Runtime 内保持固定，更改需要重启。

授权判断应在 `next()` 前完成，并 return 或 await 委派链。之后再拒绝只能取消未完成工作，不能撤销已经提交的 I/O。对外完成与链路 settlement 分离；未等待的下游仍占用原 graph 和 pending 额度，直到所有已启动工作与清理结束。因此，不合作的可信插件可能仍需停止该 generation；快速返回拒绝并不会强杀其 Promise。

配置检查间隔为 250 ms；stderr 只输出固定、无敏感内容的状态消息。Ctrl-C 或所有者断开会停止 Runtime，`--timeout` 限制整个运行期（含插件初始化和更新）。插件仍是可信 Host 扩展：永不完成或同步阻塞的插件代码并不是可独立抢占的沙箱。

## Engine Gate 边界

真实 V8 字符串和 Wasm 回调已接入独立 Host worker 的 `ctx.holo.engineGate`。仅有 Policy 权限还不够，必须有插件明确批准；字符串保留原源码/Context，必须可精确编码为 UTF-8；Wasm 使用原生 BufferSource 暂存。两者复制前都有 16 MiB 硬上限。Wasm streaming API 接受真实共享 Response，有界缓冲后进入同一原生 Gate，不承诺增量编译。配置、取消、有界 Host-only 字符串源码读取与 revision drain 语义见 [Engine Gate](engine-gate.zh-Hans.md)。实验性独立 Inspector 的安装与限制见 [Native Inspector](inspector.zh-Hans.md)。

如需源码读取审计，按 [Engine Gate](engine-gate.zh-Hans.md#可选的持久读取审计) 显式选择 `diagnosticAudit`。它在返回副本前同步有限元数据，不记录源码或 Network 正文；私有日志文件及保留策略归 Host，而非 Guest 或 Observer 插件。

## Runtime Observer（部分支持）

完整独立入口和 Service 用法、回调投递限制及外部 sink/隔离缺口见 [Observer 指南](observer.zh-Hans.md)。

独立入口的 owner 可另行选择实验性[独立诊断 Profile](observer-profiles.zh-Hans.md)并输出私有 JSONL。模块在专用、同二进制辅助进程中执行；下述 inline 闭包不会被迁移或获得新隔离。受管执行另用 owner-private 的 [Service Profile 安装](managed-observer-profiles.zh-Hans.md)，不序列化 Node 回调。

可信 Cordis 插件通过 `ctx.holo.observe({events: ['runtime.terminated'], maxQueuedEvents: 16, callbackTimeoutMs: 50}, event => { /* Host-only sink */ })` 注册。Diagnostics Policy 必须允许每个请求事件。Native 可选支持 `script.compiled`、`script.execution-started`、`script.execution-finished`、`runtime.exception`、`runtime.terminated`；script 事件还须 `acceptHighCost: true`。GC、内存压力和 Promise rejection Observer 事件暂不支持。

准入取 Policy、平台支持/opt-in、Host 上限的交集：最多 256 个排队事件，回调期限最多 1000 ms。独立引擎队列有 64 个槽，每条最多 8 KiB，不占 Gate 命令容量。订阅事件有界且允许丢弃；Observer 返回值和失败诊断本身不是授权决定。但 inline 回调仍共享插件的 Host 闭包状态，可以影响该插件后续的 Gate/Middleware 逻辑，所以当前 partial 实现未强制隔离监控与授权的相互影响。事件只有固定 metadata、虚拟来源和摘要，没有源码、正文或 Host Context。执行 hook 只覆盖显式模块/CJS 执行根，不保证所有隐式依赖或 eval/Function 入口，也不保证完整 before/after 配对。

Inline 回调只在可信 Host worker 执行，不进入 Guest。未完成的异步回调不阻止 Guest 终止；dispose/close 会隔离晚到诊断。但同步死循环可能无限阻塞后续 Host 授权；只有显式 Runtime 期限、取消或其他致命 watchdog 条件触发时，才终止整个代际。独立入口默认没有期限，需要有界运行时应设置 `--timeout`。另行选择的诊断模块模式提供执行器隔离，不迁移既有闭包，也不代表完整 Native/M4 覆盖；Observer 负责监控，不负责授权。
