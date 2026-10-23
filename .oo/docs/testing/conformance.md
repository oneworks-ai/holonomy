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
`process-v86.test.mjs` 供 Node/Desktop 与 Android 使用同一 JS 合同；升级镜像已有 Android API 35 arm64 模拟器证据，物理设备仍未验收。JS 用例负责 `node:child_process` 的返回值、
callback、stdio、退出与公开错误语义，Android instrumentation 只负责资产打包、启动、restart 和 JS runner
终态。运行时需同时传入对应的 `--capability-runtime` 请求，并由 Host 安装同名 Process profile。

当前默认公共 conformance 覆盖 Console、Timers、`node:path`、`node:buffer`、模块 URL、Fetch JSON 与 Fetch
abort；显式 capability conformance 另外覆盖受控 v86 `node:child_process`、`/workspace` FUSE、TCP/UDP/DNS、
Device/System 投影，以及升级镜像对 Guest 后续 exec 的拒绝。此前镜像的后代执行前准入证据不能沿用。

`crypto-v1.test.mjs` 与 `storage-kv-v1.test.mjs` 同样拥有公开 JS 断言；Android instrumentation 只装配生产 SDK、原生 Provider、私有测试目录及 generation，并检查 JS runner 终态。Crypto 的内存限额和 Storage 的逻辑取消不等于进程 RSS 硬上限或原生 worker 已物理退出。

显式 v86 验证使用分段预算：Host 缺省冷启动上限 300 秒，进程执行预算在 ready 后起算；测试外层按启动、执行、传输和清理余量推导，而非用 90/120 秒包住整个 VM 创建。固定 suite 最多启动 12 个独立 VM，最坏测试等待上界很长，不是启动性能 SLA。普通 Runtime/SDK 不经过这一路径。JS runner 13 项终态、instrumentation 正常退出以及所属 VM worker 已退出是不同的必要证据；仅出现中间日志或 cleanup marker 不能算通过。

## 独立 Native 持续运行

在 macOS arm64 仓库开发环境中，选择已构建的真实 `holo`：

```sh
HOLONOMY_NATIVE_TEST_EXECUTABLE=/absolute/path/to/holo \
  HOLONOMY_NATIVE_SOAK_MS=300000 \
  pnpm test:native:sustained
```

时长单位是毫秒，允许 185000–1800000，缺省为 185000。这只选择持续工作负载的时长，不修改单次能力操作的超时或权限。测试持续执行文件、Crypto 和本地 HTTP 操作，并穿插有效与无效插件配置更新；成功要求实际 CLI 退出和所观察 Runtime 进程消失。RSS/FD 是观测值，不等于无泄漏证明。

Node 用于仓库侧 fixture 驱动，实际用户 JS 由所选 Native 二进制在空 `PATH` 下运行。HTTP 取消、清理和时长边界的快速基础设施测试在 `pnpm test:native:fixtures` 中；它们不替代真实 Native 持续运行结果。
