# Native v86 的设备与系统桥接

[English](process-v86-capabilities.md) · [Host 配置](host-configuration.zh-Hans.md)

显式安装的 Experimental Native v86 环境可通过镜像内的 `hoholo` 读取 Host 选择的设备/系统能力。调用回到同一个 Kernel、Policy、Cordis 插件及现有 Provider/投影；不会用 Linux 虚拟硬件或 `/proc` 猜测宿主信息。桥接领域默认关闭。

## Host 选择

先按 [Host 配置](host-configuration.zh-Hans.md)准备 feature 构建、摘要固定的镜像、私有清单和 `--experimental-v86-process`。在选中的私有 Process profile 中设置：

```json
{
  "environment": {
    "allowedScopes": ["processTree"],
    "defaultScope": "processTree",
    "capabilityBridge": { "domains": ["device", "system"] }
  }
}
```

这是 profile 片段，不是完整清单。同时安装指向 `/usr/bin/hoholo` 的逻辑 executable ID `hoholo`，并在 Process Policy 中显式允许它。Runtime 代码不能选择领域、替换镜像或传入其他原生可执行路径。

领域只选择桥接，不授予 Device/System 权限。例如，把以下字段合并到现有 Host 配置和 SandboxPolicy 中：

```json
{
  "deviceProvider": { "implementation": "builtin.darwin-device-v1" },
  "systemProjection": {
    "schemaVersion": 1,
    "fields": {
      "os.arch": { "mode": "synthetic", "precision": "exact", "value": "x64" }
    }
  },
  "sandboxPolicy": {
    "schemaVersion": 2,
    "systemInformation": {
      "defaultMode": "unavailable",
      "fields": {
        "os.arch": { "allowedModes": ["synthetic"], "maxPrecision": "exact" }
      }
    },
    "device": {
      "defaultAccess": "deny",
      "maxEventsPerSecond": 1,
      "maxQueuedEvents": 0,
      "maxSubscriptions": 0,
      "operations": {
        "device.summary.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.form-factor.read": {
          "access": "allow",
          "maxPrecision": "coarse",
          "maxPrivacyTier": 0
        }
      }
    }
  }
}
```

这段配置本身不会启用 Process；保留先前的 Process Policy 与私有 profile 选择。`x64` 是 Host 刻意指定的 synthetic 值，不表示宿主或 VM 的真实架构。其他 System 字段也必须单独选择类型正确的值、模式与精度上限。

## 命令和权限

| Linux 命令                                   | 结果                                   |
| -------------------------------------------- | -------------------------------------- |
| `hoholo system read os.arch`                 | 所选 Host 字段的 JSON 值               |
| `hoholo device summary`                      | 类型化 Summary；每个子字段仍需独立权限 |
| `hoholo device read device.form-factor.read` | 带状态、精度和 revision 的独立 reading |

使用现有 JS API 调用逻辑 ID，例如 `execFile('hoholo', ['system', 'read', 'os.arch'], { encoding: 'utf8' }, callback)`。它是 Linux 内的程序，不是 Host shell 或 npm CLI。成功时 stdout 输出 JSON；拒绝时退出码为 1，stderr 只有固定机器码，不带原生异常或路径。

Host 插件可在 `request.source` 中看到 environment、executable ID、Linux PID、进程 resource 和 synthetic process ID。父/root PID 与启动 ticks 仅在可信协议已报告时才提供；当前一次性 capability 路径可能省略启动 ticks，不用猜测值代替。独立进程调用拥有不同的 environment/resource 标识。System 操作沿用 Registry 的同步语义，因此对应 handler 必须同步；Device 的 Promise 操作可使用异步 handler。Policy 允许的 System 字段仍可被 Host 插件拒绝。

例子只允许 Summary 内的 form-factor。display、input、lifecycle、power 仍为 `permissionDenied`、精度 `none`、revision 0，且没有 value。Summary 永不包含 Tier 2 状态或 Wi-Fi identity。不支持的命令与事件订阅会被拒绝；这条一次性 wire 不是 Linux 事件流，直接 JS Device 订阅仍是另一项 API。

共享桥接最多允许 64 个在途调用，每次最多 30 秒，并受更早的 Kernel/Process 取消约束。底层调用被取消或超时后，其有界槽位保留至实际 settlement；迟到结果不能覆盖已选响应。不结束的受信任 handler 需要正常 Runtime teardown，不能假定 Promise 可被强杀。

## 验证与边界

完成 feature 构建后运行 `HOLO_V86_PRODUCTION_ASSET_ROOT=/absolute/verified-agent pnpm test:native:v86-capability`。它以空 PATH 执行实际 `holo test`：7 个启用领域的 Guest JS 用例，以及 1 个关闭领域的用例。Host 驱动只负责安装 fixture 和核对报告，Node 不是被测 Runtime。

当前证据限于 macOS arm64 和固定 agent 镜像，覆盖真实 `hoholo`、Host 投影选择、Native Device 读取、隐私裁剪、按进程来源拦截与默认关闭领域。不代表物理设备变化、Linux 事件订阅、任意原生设备 API、其他平台对等支持或晋升 Stable。插件配置 watch 不能扩大 Policy、profile 领域或更换 Provider。
