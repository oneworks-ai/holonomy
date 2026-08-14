# RFC-0001：验证、发布与开放问题

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 21. 测试策略

### 21.1 Kernel 合同

- Middleware 洋葱顺序、一次 `next()`、短路、异常和 finally；
- Policy 先于 Host Middleware 且不可放大；
- Policy v2 unknown-field、canonical digest、旧版本 admission 与 generation 不可变；
- Capability `allOf`/`anyOf` 分支选择、最小 authority binding 和 unknown version；
- CanonicalResource requested/resolved、路径/URL歧义、redirect/symlink 重准入；
- Guest 参数与 Host 结果的 getter/Proxy/thenable/toJSON/循环/跨 Realm 快照反例；
- 参数/结果 Schema、配额、Realm copy 和稳定错误；
- registration/disposal snapshot、cancel、deadline 和 generation fencing；
- callback、sync、promise 三入口映射相同 operation。

### 21.2 Module/Realm 安全

- static/dynamic import 不能取得系统 builtin；
- default、namespace、named import 和嵌套 namespace 均被代理；
- `constructor.constructor`、Reflect、symbols、descriptors、thenable 和旧引用；
- Host object、Error、AbortSignal、TypedArray 和 opaque handle 不跨 Realm 泄漏。

### 21.3 Device 合同

- Node/Desktop/Android 使用同一 schema vectors；
- Host system projection 的 real/synthetic/redacted/unavailable 逐字段 vectors；
- unsupported/unavailable/denied/redacted 不混淆；
- Wi-Fi 状态、身份和网络使用权限互相独立；
- 动态事件 sequence、overflow、dispose 和 generation fencing；
- Android emulator 验证 power/connectivity/display 等代表性真实路径。

### 21.4 Engine Hook 固定用例

维护一个小而稳定的专项 corpus：

```text
direct eval lexical scope
indirect eval
Function / AsyncFunction
Generator / AsyncGenerator
Wasm allow/deny/limits
dynamic import through controlled loader
CDP compileScript/runScript/callFunctionOn/setScriptSource
Wasm Module/compile/instantiate/streaming
node:vm/worker/module native escape remains unavailable
middleware allow/deny/timeout/cancel
multiple VM contexts
restart/dispose/service disconnect
Inspector coexistence
no Host object leakage
```

这组固定用例只在需要的 Engine 组合运行：

- 当前支持的 Node/Embedded V8；
- Electron 实际使用的 Node/V8；
- 升级候选版本；
- Native Hook 或 Engine Adapter 相关 PR；
- 发布平台和定期兼容任务。

不得要求每个 Node 版本重复整个仓库全量测试。普通 PR 跑常规单元测试；Engine 变更跑固定 Hook corpus；Engine 升级通过 corpus 后再跑代表性 Runtime E2E。

### 21.5 E2E

- Host 创建 Runtime 并注入三类 Context 投影；
- entry 第一行访问 FS/Wi-Fi/eval 时初始 Middleware 与 Gate 已安装；初始配置失败时 entry 副作用为零；
- CDP list 只显示 Inspector 投影；
- Guest `holo:runtime` 只看到 Guest 投影；
- `node:fs`/`holo:device` 调用经过应用自定义 Middleware；
- `node:child_process`在Host注册ProcessProvider后经过同一Middleware，shell/mount/network/credential不能绕过Policy；
- 一个 real Fetch 和一个 Network Mock 请求经过 Broker，redirect/private-address/passthrough 不扩大 authority；
- 同步与 Promise 调用得到相同授权结果；
- Runtime restart 后 Context 与 Middleware generation 正确更新；
- DevTools/Inspector 执行不能绕过 Provider。

## 22. 性能与限额

- Operation Registry 在 Runtime 创建时冻结，调用时不得解析任意规则文本；
- Matcher 预编译成有界结构，禁止运行任意正则；
- Middleware 链按 operation 建索引，避免每次扫描全部注册项；
- Host/Guest/Inspector Context 分别设置总字节、深度、键数、数组长度和字符串限制；
- Engine Gate 只发送源码长度、摘要、类型和 callsite；Host 必须显式调用受限 reader 才能读取源码；
- Observer 使用每 Runtime 有界队列和 dropped count；
- 高频非敏感快照可以由 Provider 缓存，但缓存键必须包含 generation 和 policyDigest；
- 性能目标和默认限额在实现阶段通过 benchmark 固化，不在 RFC 中凭空承诺数值。

## 23. 迁移与交付阶段

实现与发布只使用 M2、M2.5、M3、M3.5、M4 这一套里程碑，不再并行维护 A–E 阶段编号。每个里程碑的 entry/exit、证据、非目标和 rollback 由[附录 G](milestones.md)冻结；每次真实 E2E 后仅按已完成能力增量发布。RFC 文档完成不等于 M2 完成，安全能力内核完成也不等于全部生产 Provider 已完成。

## 24. 被拒绝的方案

### 24.1 为所有能力创建 `holo:*`

拒绝。会重复 Node 标准、破坏生态兼容并造成两套权限入口。

### 24.2 Proxy 包住系统原生模块

拒绝。遗漏 trap、嵌套对象或旧引用即可绕过，且无法按 Runtime 隔离。

### 24.3 修改全局 `eval`

拒绝。会破坏 direct eval 的 lexical scope，无法保持标准 JavaScript 语义。

### 24.4 把 `prompt` 写进 SandboxPolicy

拒绝。Policy 是硬上限；弹窗、缓存和产品决策属于宿主 Middleware。

### 24.5 Holonomy 定义业务主体枚举

拒绝。Host Context 是宿主任意 schema，Holonomy 只负责隔离和投影。

### 24.6 用 Observer 执行授权

拒绝。Observer 是旁路、可丢弃的监控；授权必须走不可绕过的 Middleware 或 Engine Gate。

### 24.7 立即 fork Node.js

拒绝作为首选。先验证官方 Node + 隔离子进程 + 窄 V8 Hook；只有证据表明无法满足时才升级 Engine 方案。

### 24.8 把所有虚拟 Linux 实现伪装成同一种 Backend

拒绝。v86、agentOS与WASIX分别具有完整VM、虚拟kernel和WASI/WASIX程序边界，不共享二进制兼容性或安全声明。它们只共享附录J的Host profile、ProcessProvider SPI、资源与生命周期合同；每个实现仍须独立发布descriptor probe和E2E。本RFC不把CPU执行器、Linux syscall/process/VM/signal/socket/TTY/fakefs重写纳入路线。

## 25. 待实现阶段确认的问题

以下只允许作为实现 ADR 选择，不得改变本 RFC 的公开合同：

- Host Context 三类默认限额和是否允许宿主进一步收紧；
- Host Middleware Registry 的线程模型和 Android/Desktop 具体注册 API；
- 同步 blocking bridge 的默认 timeout 与递归检测；
- Native Hook 支持的 Node/Electron/V8 构建矩阵；
- 可选 permission middleware 包的最终 npm 名称；
- `holo:///runtime/*` 一次性迁移的发布窗口。
- v86、agentOS与WASIX Backend包名、镜像/工具manifest及交付渠道；不得改变附录J的平台/Backend分轴、默认不安装和Host profile准入。

## 26. 验收条件

本 RFC 的最终实现只有在以下条件全部满足后才可声明完成；单个里程碑的退出条件见附录 G：

1. `node:*` 与 `holo:*` 命名没有重复能力或旁路。
2. Host 创建时注入的 Context 正确分离为 Host、Guest 和 Inspector 投影。
3. `node:fs`、`node:os` 和每个发布 target 的附录 D.3 exact required `holo:device` operations 经过同一 Koa Middleware/Registry；单一 Device read 不能代表 target compliant。
4. callback、sync 和 Promise 入口共享相同 operation 与 Policy，并保留 Node facade 错误语义。
5. Guest 无法注册 Middleware、取得原生模块或通过动态 import/Inspector 绕过。
6. Provider 仍执行独立 authority 和资源重验。
7. direct eval 在允许时保留 lexical semantics，在拒绝、timeout、restart 时稳定失败。
8. Observer 慢、抛错或溢出不影响 Runtime 结果。
9. Node/Desktop 固定 Engine Hook corpus 与 Android emulator 代表性 E2E 通过。
10. Network real/mock/redirect 与 FS/Device/Process 使用同一 Policy→Resource→Middleware→Provider 权威链。
11. 公开双语文档、支持矩阵、模块 README 和 OpenAPI 只声明真实完成并验证的部分。

## 27. 参考资料

- Node `vm.createContext()` 的 `codeGeneration.strings/wasm` 仅提供 Context 级开关：<https://nodejs.org/api/vm.html#vmcreatecontextcontextobject-options>
- V8 提供 code-generation callback，可在字符串编译前允许、拒绝或修改：<https://v8.github.io/api/head/v8-callbacks_8h_source.html>
- Node C++ addon 直接使用 V8 API 时不享有跨 Node major 的 ABI 稳定性：<https://nodejs.org/api/addons.html>
- CDP Target discovery 的标准 TargetInfo 字段：<https://chromedevtools.github.io/devtools-protocol/tot/Target/>
- Node `child_process` API与错误/事件形态：<https://nodejs.org/api/child_process.html>
- v86项目与API：<https://github.com/copy/v86>
- agentOS项目与文档：<https://github.com/rivet-dev/agentos>
- WASIX说明：<https://wasix.org/docs/explanation/extensions-to-wasi>
