# RFC-0001 附录 G：里程碑与分层验收

[返回 RFC 总览](../0001-holo-capability-runtime.md)

RFC 写完不等于 M2 完成。里程碑只按本附录的 M2、M2.5、M3、M3.5、M4 编号，不再维护一套平行的 A–E 阶段。

## G.1 唯一里程碑序列

| 里程碑 | 目标                                                                     |
| ------ | ------------------------------------------------------------------------ |
| M2     | 机器可验证的合同冻结，不扩大公开支持                                     |
| M2.5   | Context、Policy、Broker、Middleware 与 Provider authority 的安全能力内核 |
| M3     | FS、Device、System 与 Network 的生产 Provider v1                         |
| M3.5   | 可选 Process/Linux Backend profile                                       |
| M4     | 逐次 Engine Gate、窄 Native Hook 与完整绕过矩阵                          |

发布不是独立里程碑。README、`.oo/docs`、OpenAPI 与 `.oo/skills` 只能在对应场景通过真实 E2E 后增量声明，不能按计划或类型草图提前发布。

## G.2 M2：机器合同冻结

### Entry

- 当前 Runtime Composer、Native Bridge、SandboxPolicy v1、Node/Android Adapter 合同稳定；
- RFC 保持 Proposed，不声明新能力已支持。

### Exit

- RFC 总览及全部规范性附录通过独立审阅；
- SandboxPolicy v2/limits、Capability、CanonicalResource/Resolution、Argument/Result Snapshot、Host System/Device/Network/FS/Process operation registries、Engine Gate/Observer 与基础类型都有 checked-in machine schema；
- Node/Desktop/Android 共用 canonical JSON、digest、origin/path、device availability 和 error mapping vectors；
- unknown field/version、默认 deny、initial admission、generation/restart 的 contract tests 通过；
- operation registry 能生成稳定 operation/capability/resource/interception/delivery 文档，但不要求生产 Provider 已完成；
- Node/Embedded V8 对 generation-level strings/Wasm 行为运行真实 probe；machine vector 对逐次 callback 和 metadata 分别记录 `behavioralProbe` 或 `profileStaticUnsupported` provenance，不把不可观测字段伪装成动态 probe。

### 非目标与回滚

M2 不承诺生产 `node:fs`、`holo:device`、`node:child_process`、逐次 Engine Gate 或公开 Host SDK。Schema/vector 未发布前可修改 Proposed RFC；机器合同进入实现后，破坏性修改必须提升 schemaVersion。

## G.3 M2.5：安全能力内核

### Entry

- M2 全部退出条件满足；
- Service/Android command 与 Node/Desktop session 可原子携带 v2 launch snapshot。

### Exit

- Host 以一个 `RuntimeCreationSpec` 原子安装 Context 三投影、SandboxPolicy v2、initial Middleware、Provider bindings 与 generation identity；任一初始准入失败时 Guest entry 副作用为零；
- 当前切片开放的所有可授权 facade 调用走同一 `Snapshot → CanonicalResource → Policy → system layer → Host Koa Middleware → Provider authority → result` 流水线；system-only continuation 的 Broker 重入属于 M3；
- initial Middleware 在 entry 之前冻结，live use/dispose 只影响后续调用；当前切片实际暴露的旧 facade 与异步 terminal 均按 generation fencing；resource/resolution token 随 M3 对应 Provider 一并验收；
- Node/Desktop 与 Android emulator 各跑一个受控 FS read、一个受控 FS write、一个 Host System 字段和一个 `holo:device` 低或中隐私读取，证明同一内核跨平台生效；这些切片不得被描述为完整 Provider 支持；
- 一个 real Fetch 和一个 mock Fetch 的首个逻辑请求经过同一 Broker；Capability Network 与既有传输策略逐字段完全一致，保证 mockOnly、redirect/private address、passthrough、body limits 与 source=`real|mock` 不因移交传输层而扩大 authority；redirect/Response continuation 的 Broker 重入属于 M3；
- 至少一个同步、一个 callback、一个 Promise facade 共享相同 internal terminal，并按对应 Node/Holo facade 转换稳定错误；
- restart/stop/disconnect、Middleware deny/throw/timeout/cancel、Provider failure 和 initial failure 均满足 exactly-once、旧代隔离及 sideEffects=0；
- OpenAPI 只发布上述已完成的生命周期和代表性场景，支持矩阵明确标注 `kernel-slice`，不能标注 target-compliant Provider。

### 非目标与回滚

M2.5 不要求附录 H 的完整 FS exports、附录 D.3 的 target required Device 集合、全部 Host System 字段、Process Provider 或逐次 eval prompt。每个能力切片可按 capability matrix 独立关闭；关闭时稳定返回 unsupported/denied，不能回退 ambient Node/OS API。

## G.4 M3：生产 Provider v1

### Entry

- M2.5 的 Policy、Context、Broker、Middleware、Provider authority 与生命周期纵向链稳定；
- 各平台 Provider descriptor 和支持矩阵由机器合同生成。
- 附录 K 的 Cordis App、Runtime Plugin Resource Bundle、包边界与 watch transaction 合同冻结；新增设计不反向改写 M2/M2.5 已完成的机器合同。

### Exit

- Node/Desktop 与 Android emulator 跑通附录 H/H.1 声明支持的全部 FS exports，包括 virtual root、handle-relative open、atomic write、symlink/TOCTOU、quota 与 unsupported vectors；
- 每个发布 target 通过附录 D.3 全部 exact required Device operations/eventKinds；optional 项只能按该 target 的真实 descriptor 声明；
- Host System Projection 的全部已声明字段通过默认无泄漏及 real/synthetic/redacted/unavailable E2E；
- Network real/mock/redirect/WebSocket-support-declaration、响应 continuation、诊断 body/source 和 Network Rules revision 均通过共享合同及平台 E2E；
- system-only continuation 经过 Policy/quota/Provider 而不重复 Host 业务授权，并具备 generation-bound resource/resolution token；
- sync/callback/promise 的全部已声明 Node facade 通过参数、结果、callback arity 与错误兼容 vectors；
- Node/Desktop 的 CLI/Service 能把 package、相对路径和 Host 允许的绝对路径统一转换为 `holo-plugins:///*` bundle；Android 使用相同 bundle contract，不引入 Native 插件 API；
- `holonomy run --watch` 对 `holo.config.json` 的有效 `plugins[]` 变更完成有序 diff、staging、原子 graph revision 切换与 Cordis scope dispose；无效 JSON/Schema、加载失败和重复 ID 保持 last-known-good graph 不变；
- 双语公开文档、OpenAPI、模块 README 和场景 Skills 只包含真实通过的平台/operation。

### 非目标与回滚

M3 不以 Process/Linux Backend 或逐次 Engine Gate 为完成条件。Plugin source watch v1 只观察配置及其资源解析结果，不承诺任意源码 HMR。每个 Provider 可独立回退到稳定 unsupported；不得保留 facade 后改走宿主 ambient API。

## G.5 M3.5：可选 Process/Linux profile

### Entry

- M2.5 的 Policy、CanonicalResource、Broker、Provider authority 与 generation 生命周期稳定；
- M3.5 可与 M3 Provider 子轨并行，但不得绕过或放宽任何 M3 共用资源边界；
- target 明确选择是否发布 `node:child_process` profile。

### Exit

- 进入支持声明的 target 通过附录 J/J.1/J.2 的 Node facade、Process authority、stdio/backpressure、process-tree cleanup、timeout/abort/signal 与 Backend-missing E2E；
- shell、argv、env、cwd、mount、network 与 credential authority 无旁路；program/shell semantic digest 不碰撞；
- Backend descriptor、Host profile 与实现注册分离；平台只选择已安装且声明兼容的 Backend，未知、未安装、平台不匹配或配置无效均在 Guest entry 前失败；
- 至少一个目标平台上的 Stable Backend 通过真实 E2E；v86、agentOS、WASIX 或其他 Experimental Backend 各自提供 descriptor probe、二进制边界与真实 E2E 后才能进入支持矩阵，但不阻塞核心 M3.5；
- `runtime` 与 `processTree` environment scope 由 Host profile 给出默认值和允许集合；Guest 的 Symbol options 只能请求该集合内的 scope，不能选择 Backend、镜像、mount、network 或 credential；
- 未安装或未授权 Backend 时稳定 feature-detect/unsupported，不回退到 ambient `child_process`。

### 非目标与回滚

不从零重写 Linux 用户态内核，也不要求所有 target 提供 Process。Backend 可从单个 target manifest 移除而不影响 M3 基础能力；平台未安装 Process Backend 不等于该平台整体 Disabled。

## G.6 M4：逐次 Engine Gate

### Entry

- M3 的生产能力链稳定；
- 窄 V8 addon 的 Node/Electron/V8 构建矩阵已确定。

### Exit

- 附录 F 的每个受支持 entrypoint 在编译前执行 exactly-once coarse Gate，且只按真实 capability probe 声明可观测粒度；
- direct eval lexical semantics、Function/Wasm/dynamic import/CDP、timeout/cancel/restart/disconnect corpus 通过；
- source reader 一次性/限额/无泄漏，Observer support/cost/opt-in 矩阵真实可验证；
- vm/worker/module native escape 默认不可达；若开放子 Realm，Policy 继承、消息快照和父子取消 E2E 通过；
- Node/Desktop 发布产物的相关 Engine 组合运行固定 Hook corpus，Android 对等 Engine Gate 用例通过 emulator。

### 非目标与回滚

M4 不内置授权 UI、Grant 策略或全函数 tracing，也不要求 fork Node。Native Hook 加载、ABI 或 corpus 失败时，整代 Runtime 必须回退到显式 generation 级 deny/allow 或拒绝启动，不得静默关闭 Gate。

## G.7 证据与发布

每个里程碑都需要 machine schema/vector、owner tests、代表性 E2E、独立审阅、支持矩阵 diff 和回滚演练。`Proposed` RFC、局部单测或窄平台样例都不能单独作为 exit 证据。

公开中英文文档、模块 README、OpenAPI 与场景 Skill 按实际完成的里程碑增量发布。Skill 必须完整拥有一个可执行 OpenAPI 场景后才能出现。
