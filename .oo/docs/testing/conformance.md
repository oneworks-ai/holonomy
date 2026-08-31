# Conformance 使用与证据

[English](../en/testing/conformance.md)

Conformance 从真实 `holonomy test` 入口执行同一组 `node:test` 文件，验证 CLI → Service → Adapter → 共享 Runtime → 公共 JavaScript API 的完整开发者路径。

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target node \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Android 使用同一文件：

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

普通 `describe`/`it` 是跨平台公共分母，缺失能力会失败而不是自动 skip。`describe.holonomy.android` 与 `it.holonomy.android` 表示明确的平台专属承诺，单独报告，不进入公共分母。

Android instrumentation 是 Adapter 集成证据，不是 CLI E2E。模拟器结果标为 `emulator`，只有真实连接物理设备并完成执行后才能声明 `physical`。

需要显式 Host profile 的能力用例放在 `conformance/capabilities/`，不会混入默认的无权限测试集合。例如
`process-v86.test.mjs` 由 Node/Desktop 与 Android 原样执行；JS 用例负责 `node:child_process` 的返回值、
callback、stdio、退出与公开错误语义，Android instrumentation 只负责资产打包、启动、restart 和 JS runner
终态。运行时需同时传入对应的 `--capability-runtime` 请求，并由 Host 安装同名 Process profile。

当前默认公共 conformance 覆盖 Console、Timers、`node:path`、`node:buffer`、模块 URL、Fetch JSON 与 Fetch
abort；显式 capability conformance 另外覆盖受控 v86 `node:child_process`、`/workspace` FUSE、TCP/UDP/DNS、
Device/System 投影与后代执行前准入。
