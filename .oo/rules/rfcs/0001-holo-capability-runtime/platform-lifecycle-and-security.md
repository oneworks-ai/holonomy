# RFC-0001：平台实现、生命周期与安全

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 18. 生命周期与并发

- Runtime Context、SandboxPolicy、principal 和 policyDigest 在 generation 内不可变；
- Guest entry 只能在初始 Policy、Capability branch、Context、Middleware、Provider 和 Engine Gate 同一事务全部冻结后执行；
- restart 保持稳定 processId，创建新 generation、Engine Context、Provider、Middleware snapshot 和 Inspector lease；
- Middleware Registry 的注册/注销影响之后的新调用，已开始调用使用 admission 时的链快照；
- 每个调用的第一终态获胜，late result/error/observer event 被 fencing；
- 同一授权请求是否合并由可选权限包或宿主决定，Kernel 只提供 requestId 和可取消上下文；
- Runtime stop/dispose 必须取消 Middleware、Engine Gate、Provider 和订阅，并关闭不透明资源；
- 父 Runtime stop/dispose 必须取消所有受控子 Realm/Worker，IPC/Host 断线不得遗留执行面；
- Host Context projector 或 Middleware 不得在 Guest Runtime thread 上执行不受限阻塞工作。

## 19. 平台实现

### 19.1 Android

- Android Host 在 `SessionRuntimeFactory.create(context)` 之前构造并验证 Runtime Context；
- command-v2 的 launch snapshot 原子携带 Policy、初始 Middleware descriptor、Provider binding 和 Engine Gate descriptor；
- Supervisor 为每个 logical Runtime/generation 保存不可变 Context digest 和投影；
- Guest 调用通过 Javet/V8 runtime thread 进入 Broker；
- 异步授权 UI 在 Android main thread，决定通过独立 control path 返回；
- 同步 Guest API 只阻塞 runtime thread，不阻塞 main thread；
- `holo:device` Provider 使用公开 Android API，并用 callback 更新动态事件；
- Emulator 是本 RFC 的 Android 功能验收基线；物理设备可以作为额外证据，不是本提案的强制门禁。

### 19.2 Desktop/Node

- 每个 Runtime 继续使用独立 Node 子进程和 VM Context；
- Node 子进程只能消费 Host 冻结的 system projection，不得在 Guest facade 内直接调用 ambient `node:os`/`node:process`；
- Host 原生模块只在子进程可信闭包中，Guest 获取 Synthetic Module facade；
- Desktop main process/Service 注册 Middleware 和投影 CDP Context；
- 同步授权依赖独立 IPC/Native thread，不依赖被阻塞的 Guest event loop；
- OS process sandbox、Node permission controls 和受限用户是纵深防御，不代替 Broker；
- Native Hook 是窄 Engine Adapter，不成为新的权限产品层。

### 19.3 Headless Node

无 UI 的 Host 仍可注册固定策略、远程审批或测试 Middleware。没有注册 Middleware 时由 Host 创建选项决定 `deny` 或 `continue`；无论哪种都不能越过 SandboxPolicy。

### 19.4 Process Backend

- ProcessProvider只由可信Host Runtime Factory或Host装载的JavaScript/Cordis Backend资源注册；Guest只使用`node:child_process` facade。
- `node`、`desktop`、`android`是平台；`native`、`virtual-machine`、`virtual-kernel`、`wasix`是Backend family，两者不得混为支持状态。
- 资源中是否包含Backend、Host是否注册、平台descriptor是否兼容、单Runtime Policy是否授权是四个独立开关。
- Linux进程只能看到effective mounts/network/environment/credential bindings；不得继承Host ambient cwd、home、PATH、keychain或socket权限。
- v86、agentOS、WASIX等实现只能声明自己实际具备的二进制、文件、网络、同步与scope能力；虚拟化本身不代替Provider/Broker重验和quota。
- stop/restart/disconnect终止整棵generation process tree并撤销资源；后台挂起与jetsam必须产生稳定terminal和恢复证据。

## 20. 安全不变量

实现必须证明：

1. Guest 不能注册、移除或枚举 Host Middleware。
2. Guest 不能提供 principal、capability、policyDigest、Provider token 或 Host Context。
3. `node:*`、`holo:*`、静态 import 和动态 import 使用同一受控 Loader。
4. Proxy target、返回句柄和错误中没有 Host Realm 原生对象。
5. Middleware 短路不能绕过结果 Schema、配额和 Realm 重建。
6. Provider 在每次执行前独立重验 authority 和资源绑定。
7. `eval`、Function、Wasm、Inspector 和动态 import 不会扩大原调用 authority。
8. restart 后旧 facade、callback、句柄、Middleware continuation 和 Inspector lease 均失效。
9. Host、Guest、Inspector Context 不会自动互相复制。
10. 敏感设备标识符和网络拓扑默认不进入 Guest、CDP、日志或事件。
11. 慢 Middleware 可以阻塞自己的调用，但慢 Observer 不得阻塞 Runtime。
12. Service/Host 断线、deadline 和 Engine termination 都能解除同步等待并 fail closed。
13. Guest 参数和 Host 短路结果都经过 own-data、accessor-free、prototype-free 的对称快照。
14. Middleware、Grant key 与 Provider 使用同一个 canonical resource digest；resolved resource 变化会重新准入。
15. 未声明的 Capability、Policy 字段、Realm creator、Inspector code operation 和系统信息字段默认拒绝。
16. 初始安全链安装失败时 Guest entry 副作用为零。
