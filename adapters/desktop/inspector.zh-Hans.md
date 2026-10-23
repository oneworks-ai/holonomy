# Native Inspector（实验性）

[English](inspector.md)

独立 Rust `holo` 只有显式配置私有 Unix socket 后才提供真实 V8 Inspector：

```sh
mkdir -m 700 ./private-inspector
holo --host-config ./host.json --inspector-socket /绝对路径/private-inspector/session.sock ./index.mjs
```

父目录须由当前用户持有且不给 group/other 权限，祖先目录也须可信；绑定和清理使用规范化后的父目录。socket 权限为 `0600`，接受连接时核对同 UID。不开 TCP 监听或 HTTP discovery。每次运行只接受一个有界、按行分隔的 CDP JSON 会话；入站每帧最多 64 KiB，待发数据最多 1 MiB/32 条。暂停时运行期限和所有者取消仍生效。

单独安装的机器 Service 已通过这个私有通道提供带鉴权、绑定 generation 的 Native Inspector lease。owner 在 `HOLONOMY_HOME/native-runtime.json` 写入 `{"schemaVersion":1,"executablePath":"/owner/选择的/绝对路径/holo"}`，权限设为 `0600`；可执行文件及祖先目录必须由 owner 控制，不允许不可信用户写入。然后使用该安装中的控制面 CLI：

```sh
pnpm holonomy run ./index.mjs --target native --inspect-brk --detach
pnpm holonomy process inspect <process-id>
```

控制面 CLI/Service 仍使用 Node，Guest 执行由独立 Rust 二进制完成。`--inspect` 启用检查但不等待；`--inspect-brk` 在 Guest 求值前等待 `Runtime.runIfWaitingForDebugger`。这是入口屏障，不宣称 V8 第一行断点。提前恢复可以被记住，但 Host 初始化和模块计划安装完成前仍拒绝执行代码的命令。运行期限和 owner 取消在初始化、等待和暂停期间均有效。

同代 lease 共用一个 Guest Inspector 连接与 debugger 状态，但请求 ID 和 lease 关闭独立。关闭一个 lease 不会关闭其他 lease；重启使旧 token 失效并关闭旧 WebSocket，不配合关闭的客户端会在有界宽限后被强制断开。执行命令仍经过真实 Runtime 的 Policy/Cordis Gate。已准入的恢复操作由 Service 持有，不随客户端断开而消失；生命周期完成后才确认成功。Native 恢复确认不明时先停止对应代际，或保留 cleanup-pending 所有权。

不宣称完整 DevTools 前端兼容或 Native Network 诊断投影；仍以下方方法白名单为准。

## 授权

只读会话和调试控制采用白名单。会执行代码的命令必须同时获得对应 `sandboxPolicy.inspector` 位、`codeGeneration.strings.access: controlled`，以及 Host Cordis Engine Gate 的明确批准。仅有 Policy 不能授权。controlled 字符串 Policy 和插件配置见 [Engine Gate](engine-gate.zh-Hans.md)。

| CDP 方法                                           | Inspector Policy 位 |
| -------------------------------------------------- | ------------------- |
| `Runtime.evaluate`、`Debugger.evaluateOnCallFrame` | `evaluate`          |
| `Runtime.compileScript`                            | `compileScript`     |
| `Runtime.runScript`                                | `runScript`         |
| `Runtime.callFunctionOn`                           | `callFunctionOn`    |

未知方法和条件断点注入被拒绝。请求 `Debugger.setScriptSource` 仍要经过 Policy/Gate，但锁定的 V8 返回不支持，不能依赖 live edit。单独选择的 source reader 复用其他 Gate 路径同一个有界 Host-only 字节通道。

只注册 Guest Context；不注册 Host worker 和模块规划 Context。客户端 `sourceURL` 只是 V8 显示标签，不是可信来源；Inspector Gate 的 origin 标记为 unavailable，保留 Host scheme 也不能用作显示标签。由 Loader 推导的真实模块来源仍单独处理。Host 插件不能从任意源码文本或标签推断权限。

## 当前证据和限制

真实无 Node 二进制已覆盖会话查询、Policy/Host 拒绝、批准后的求值/编译/运行/函数调用、暂停恢复、源码读取、提前恢复和不可信 origin 回归。Service 测试与公开 CLI/HTTP/WebSocket 验收覆盖 token、入口等待/恢复、两个 lease、重启和旧连接关闭。socket EOF 会离开暂停循环，dispatch 始终在 Guest 引擎线程。当前证据仅为 macOS arm64，完整 CDP、浏览器 Network 仿真与完整 M4 验收仍未完成。
