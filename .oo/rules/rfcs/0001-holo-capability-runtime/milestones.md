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

### M3 内部交付检查点

这些检查点是 G.4 Exit 的实施拆分，不建立新的公开里程碑编号；只有五项全部闭合，M3 才能从“进行中”变为“完成”。

| 检查点               | 当前状态  | 范围                                                                                                              | 退出证据                                                                                             |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| M3-R：Runtime Plugin | 已完成 v1 | `holo-plugins:///*` bundle、Host-only 资源装载、Cordis App、Capability graph/drain、CLI watch transaction         | Node/Desktop graph/drain/watch与Android独立Host realm静态同步Capability interception均通过平台E2E    |
| M3-F：Filesystem     | 已完成 v1 | 附录 H/H.1 的 path、handle、directory、atomic write、watch、quota、AbortSignal、resolution/TOCTOU                 | 同一Guest conformance在Node/Desktop与Android跑完；旧resource、overflow、quota、Abort与TOCTOU反例闭合 |
| M3-D：Device/System  | 已完成 v1 | 各发布 target required Device operation/event 与 Host System 四种投影；Host 自定义 Context 不代替这两类 authority | Android真实平台change、revision/resync与fencing及Node Headless descriptor、全System默认无泄漏E2E闭合 |
| M3-N：Network        | 已完成 v1 | redirect 每跳、Response metadata/body/clone、DNS resolution、real/mock 与诊断 reader 的 Broker continuation       | Node/Desktop 与 Android 的 redirect/private-IP/body/clone/cancel/Rules-revision 共享反例             |
| M3-X：汇合与发布     | 已完成 v1 | system-only continuation、resource token、Facade 兼容、双语文档、OpenAPI、Skills 与支持矩阵                       | 全门禁、跨平台真实 E2E、真实workspace tarball安装、独立审阅与逐Provider support declaration          |

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

### M3.5 完成后的 Process 增量检查点

M3.5 以至少一个 Stable Backend 通过真实 E2E 为完成条件；下列检查点扩展 v86 的可用性与支持等级，但不反向把已完成的核心 M3.5 标记为未完成，也不建立新的正式里程碑编号：

| 检查点               | 当前状态               | 目标                                                                                                                                                                                                                                                                                  | 退出证据                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M3.5-U：HoloUV 基础  | 已完成 v1              | 共享 Environment Runtime、Process Backend SPI 与 operation/resource/lifecycle 语义；JS 保持 Node-compatible facade，Backend 对齐 libuv 的 handle/request/loop/process/stream/FS/network 语义；v86 daemon 为 `/sbin/holo-uvd`，wire protocol 不暴露 `uv_*` 内存结构                    | Native Darwin 可直接实现同一 SPI，v86 使用 Host Driver + Guest System Adapter；两者共用 vectors；`holo-uvd` 的 spawn/stdio/signal/close/restart E2E；平台差异只出现在 Adapter                                                                                            |
| M3.5-I：Linux 镜像   | 已完成 v1              | Host 选择摘要绑定的 `minimal`、`base`、`agent`、strict `custom` profile；`base` 包含 BusyBox、`/bin/sh`、`cat`，`agent` 包含 `curl`/CA、`git`、`ssh`、`jq`、`nc`、`timeout`；Runtime JS 不选择镜像和工具                                                                              | 可复现构建、artifact digest、SPDX SBOM、锁定依赖与 executable allowlist；真实 shell、管道、`cat`、`curl` E2E；生产镜像拒绝 selftest fixture，Runtime 启动不联网安装工具                                                                                                  |
| M3.5-B：v86 能力桥接 | 已完成 Experimental v1 | 后代 exec 准入与 Host-only gate deadline；绝对 `execve`/`execveat`、PATH 绝对解析和 executable TOCTOU fail-closed；Linux FS、TCP/UDP/DNS 与 Host Device/System 投影通过版本化 Host↔Guest 通道进入同一 Broker；后代 socket 保留 Linux PID/PPID/starttime/已提交 executable attribution | Node/Desktop 与 Android emulator 的文件、网络、设备、后代 allow/deny、generation restart E2E；Guest gate 证明绝对 `execveat` allow 及相对/dirfd/`AT_EMPTY_PATH` deny；Process DNS 通过 canonical address set、TTL、resolver generation 与 rebinding resolution challenge |
| M3.5-P：支持升级     | 保持 Experimental      | 已冻结 x86-32、单核、资产体积、摘要校验、启动取消、generation restart、失败清理和资源上限的当前证据；物理 Android、64-bit/multicore 与真正 VM snapshot/restore 只作为未来支持等级晋升条件                                                                                             | 只有新增声明范围取得独立平台证据、支持矩阵 diff、安装/卸载/损坏资产/回滚演练和双语发布材料后，才允许晋升                                                                                                                                                                 |

当前活动范围只包含 Stable Native Darwin 与 Experimental v86。agentOS、WASIX、Windows Process/System Adapter 和非 V8 Desktop Engine 只保留研究证据或扩展点，不属于当前 M3/M3.5 排期；重新启用必须由新的设计决定和对应真实 E2E 建立支持声明。

### 跨里程碑事项归属

| 事项                                                           | 唯一归属     | 当前状态               | 对应退出边界                                                                                                 |
| -------------------------------------------------------------- | ------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| 普通 Runtime 的文件、设备与系统能力                            | M3-F / M3-D  | 已完成 v1              | 生产 Provider、发布目标 required descriptor、真实事件与默认无宿主信息泄漏                                    |
| JS `fetch()`、redirect 与 Response continuation                | M3-N         | 已完成 v1              | real/mock、每跳重准入、DNS/private-IP、body/clone/cancel、Rules revision 跨平台 E2E                          |
| 跨 Backend 的进程/流/handle/loop 与 OS 差异收敛                | M3.5-U       | 已完成 v1              | HoloUV 语义层、版本化 `holo-uvd` 协议、Host OS/Guest System Adapter 兼容与差异 vectors                       |
| Linux 镜像和 `shell`、`cat`、`curl` 等工具                     | M3.5-I       | 已完成 v1              | `minimal/base/agent/custom` 可复现镜像、digest、SBOM、allowlist 与真实工具 E2E                               |
| Linux 文件、TCP/UDP/DNS、Host Device/System 注入与后代执行准入 | M3.5-B       | 已完成 Experimental v1 | 全部重新进入同一 Broker；后代保留 PID/PPID/starttime/executable attribution；DNS token 固定 admitted address |
| v86 从 Experimental 升级支持等级                               | M3.5-P       | 保持 Experimental      | 物理设备、64-bit/multicore 与真正 snapshot/restore 取得证据后才可晋升                                        |
| agentOS、WASIX、Windows Adapter、非 V8 Desktop Engine          | 不在当前排期 | 仅保留研究/扩展点      | 只有新的设计决定、安装实现和独立平台 E2E 才能进入未来里程碑                                                  |

- 普通 Runtime 的文件、网络、设备和系统能力分别由 M3-F、M3-N、M3-D 完成；把同一份 authority 延伸到 Linux environment，才属于 M3.5-B。不得在 v86 内另建一套 Policy。
- HoloUV 是 M3.5-U 的公共执行抽象，不是只服务 `spawn()` 的临时 Supervisor。它统一环境生命周期、handle/request、stdio、process tree 与异步终态；Native Darwin 可以直接实现同一 Process Backend SPI，v86 则使用 Host Driver 与 Guest System Adapter，二者不要求复用同一底层系统调用代码。
- `shell`、`cat`、`curl` 等是镜像软件，不是 Runtime 内置 API。它们归 M3.5-I：`base` 已交付 BusyBox、`/bin/sh`、`cat`，`agent` 已交付 `curl`/CA、`git`、`ssh`、`jq`、`nc`、`timeout`；生产镜像仍由 Host 显式安装，不随核心包默认发布。
- Linux 内的 `curl`、`git` 和任意程序发起的连接归 M3.5-B 的 Process Network Bridge；JS `fetch()` 仍归 M3-N，两者共享 Network Policy owner，但不是同一个 operation。Experimental v1 已冻结 root 与任意后代 socket 的 environment、实际 PID/PPID/starttime 及已提交 executable attribution，不借用 root identity；新的进程归因范围必须继续提供 Guest gate 与 Host Broker 证据。
- Host 设备与系统信息归 M3-D 的权威 projection；M3.5-B 只负责把 Host 已选择的字段、模式、精度和事件安全送入 Linux。Host 未提供的字段保持 unavailable，不从 Linux ambient `/proc`、虚拟硬件或默认值反向推断宿主隐私信息。
- 32/64-bit、multicore、镜像体积、快照恢复、崩溃恢复、物理设备与支持等级归 M3.5-P。agentOS、WASIX、Windows Adapter 和非 V8 Desktop Engine 不进入这些当前检查点，除非另行重新启用。

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
