# Holonomy CLI

[English](./README.md)

`holonomy` 命令负责在 Android 或隔离的本机 Node 宿主上运行 JavaScript 与 `node:test` 文件。机器级 Holonomy Service 统一拥有设备、受管 Runtime 进程、日志、Network Rules 和 Inspector Lease，调用方不需要自行拼装 ADB 或 CDP 命令。

## 发现 CLI 能力

```sh
holonomy --help
holonomy --readme [MARKDOWN]
holonomy --llms [MARKDOWN]
```

- `--help` 输出简短的命令和参数导航。
- `--readme` 和 `--llms` 是别名；不传路径时，两者都输出这份外部使用说明。
- 传入一个 `<markdown>` 路径时，任一别名都会输出这个明确指定的本地参考文件；输入必须是普通 UTF-8 `.md` 文件，且不能超过 256 KiB。

例如，工具可以按需加载项目中的单个场景文档，而不必一次读取所有资料：

```sh
holonomy --llms ./.oo/skills/debug-runtime-process/references/cdp-api.md
```

## 运行与测试

```sh
holonomy run examples/basic.mjs --target node
holonomy run examples/debuggable.mjs --target android --device emulator-5554 --sandbox conformance/sandbox/restricted.json
holonomy test "conformance/specs/**/*.test.mjs" --target android --device emulator-5554 --sandbox conformance/sandbox/restricted.json
holonomy test conformance/specs/fetch.test.mjs --target android --sandbox conformance/sandbox/restricted.json --inspect-brk --devtools
```

`--target` 是必填项。命令默认使用 `--openapi auto`，自动启动或复用仅当前用户可访问的 loopback Service。使用 `--detach` 返回稳定的进程 ID；使用 `--env KEY=VALUE` 和 `--arg VALUE` 传递有边界的 guest 输入。`--inspect` 与 `--inspect-brk` 启用进程级 CDP Lease，`--devtools` 打开 Holonomy DevTools。

每个进程默认使用全部拒绝的 SandboxPolicy。进程需要能力时，通过 `--sandbox FILE` 传入一个有边界的普通 JSON 文件；Service 会权威校验，并在该进程 generation 内冻结策略。Service 自有的 conformance fixture 会先于 Adapter 启动完成 staging，其精确 runtime origin 会原子写入 effective policy。这个有界的 process lease 会跨终态 generation 保留，因此 restart 仍使用同一 origin；只有显式移除进程、保留期到期或 Service drain 才释放。staging 完成前，Process 响应只返回 `sandboxPolicyState: pending` 而不暴露策略；完成后只公开 effective policy 与 digest。网络访问分为 `none`、`mockOnly`、`restricted`：`mockOnly` 只允许 fail-closed 声明式 Mock，绝不会进入原生 HTTP Provider；`restricted` 只允许策略中的规范 scheme、origin、私网选择和字节/并发限额。文件系统默认 `none`，当前选择 `sandboxed` 会稳定返回不支持。Guest launch 不能提供编译后的 authority、Provider token、Runtime module 或 capability。

CLI 会把 `--root-url` 冻结为模块图根。Service 与目标 Adapter 会再次校验入口和所有随附模块都位于这个规范根之下，因此生成的 `.holonomy/` 入口不会意外缩小开发者的模块图。

显式远程 Service 在非 loopback 场景必须使用 HTTPS。Token 通过 `--openapi-token-file` 或 `HOLONOMY_OPENAPI_TOKEN_FILE` 提供，不应直接出现在命令行参数中。

## 管理 Service 与 Runtime 进程

```sh
holonomy service start
holonomy service status
holonomy device list
holonomy emulator list
holonomy process list
holonomy process logs <process-id> --follow
holonomy process inspect <process-id> --devtools
holonomy process stop <process-id>
holonomy service stop --drain
```

Service 是机器级单例，只有显式停止才退出。普通 stop 在仍有自有 Runtime 或模拟器资源时会拒绝；`--drain` 只清理由这个 Service 实例拥有的资源。终态进程和有边界日志默认保留 24 小时，也可以显式 remove。

使用 `--network-rules rules.json` 可以在入口模块执行前原子安装进程级规则集。规则不能超出不可变的 SandboxPolicy：mock-only 规则必须 fail closed，且不能 passthrough。运行中更新通过 OpenAPI Rules 资源和 `If-Match` revision 完成；guest JavaScript 不能替换 Provider、policy 或规则。

## 场景 Skills

`.oo/skills/` 不是通用的项目文档目录。只有当某个 Holonomy OpenAPI 服务已经公开完成场景所需的全部操作时，它才能在 `<openapi-base-url>/.oo/skills/<scenario>/SKILL.md` 发布对应 Skill。合适的场景包括：调试某个 Runtime 进程、为指定进程安装网络 Mock 规则、在选定设备上运行 conformance，以及收集失败证据。

这条规则依据的是 OpenAPI 的职责范围，并不是针对 CLI 或某个组件的特例。OpenAPI 无法完整执行的前置能力和工作流，继续放在各自 owner 的 help/README 中；发布后的场景 Skill 只能使用该服务的公开操作，不能自行拼装私有 ADB、CDP 或会话协议。

Service 在 `/openapi.json` 发布 OpenAPI 文档，并在 `/.oo/skills/` 下发布已经完整实现的场景 Skill。仅描述组件的资料继续留在各自 README，不会伪装成场景 Skill。
