# 原生 Desktop Device

[English](device.md) · [Host 配置](host-configuration.zh-Hans.md)

macOS arm64 原生 `holo` 可显式安装 Desktop Device Provider。它只读 CoreGraphics/IOKit 元数据，复用共享 `holo:device` facade 和原有 Policy/Broker。默认不安装，仅选择 Provider 也不会自动授予 Device 权限。

## 独立运行配置

创建 `host.json`：

```json
{
  "schemaVersion": 1,
  "deviceProvider": { "implementation": "builtin.darwin-device-v1" },
  "sandboxPolicy": {
    "schemaVersion": 2,
    "device": {
      "defaultAccess": "deny",
      "maxEventsPerSecond": 16,
      "maxQueuedEvents": 8,
      "maxSubscriptions": 2,
      "operations": {
        "device.summary.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.form-factor.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 0
        },
        "device.display.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.input.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.lifecycle.read": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        },
        "device.events.subscribe": {
          "access": "allow",
          "maxPrecision": "standard",
          "maxPrivacyTier": 1
        }
      }
    }
  }
}
```

创建 `index.mjs`：

```js
import { getDisplay, getFormFactor } from 'holo:device'
import { subscribe } from 'holo:device/promises'

console.log(JSON.stringify(getFormFactor()))
console.log(JSON.stringify(getDisplay()))
const subscription = await subscribe({
  kinds: ['display', 'lifecycle'],
  maxQueuedEvents: 8
})
try {
  for (let index = 0; index < 2; index++) {
    const { value } = await subscription.next()
    console.log(value.kind, value.phase)
  }
} finally {
  await subscription.close()
}
```

```sh
holo --host-config ./host.json ./index.mjs
```

前两个 reading 来自当前 Host；订阅先给出 `display snapshot` 和 `lifecycle snapshot`，关闭前会保持运行存活。OS 无法提供某项必需读数时，可以返回 `unavailable` 或 `permissionDenied`，精度为 `none` 且没有 value；不会拿假分辨率或假输入能力替代。

## 值与隐私

| 读数        | 当前来源与边界                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Form factor | 在私有侧有界读取型号，仅分类为 `desktop` 或 `unknown`，不返回原始型号。                                                                                                     |
| Display     | 当前主显示器的逻辑点/CSS px、缩放与方向。`standard` 不返回刷新率；显式 `exact` 可返回 OS 提供的刷新率。HDR、wide-color 为 `unknown`，不返回图像、坐标、显示器 ID 或序列号。 |
| Input       | 只枚举已注册 HID 使用类别，不打开设备，不读输入报告、键击、文本或原始标识。触控板是间接精细指针，不是触摸屏；触屏的触点上限无法安全取得时，返回 unavailable，而不猜数字。   |
| Lifecycle   | 依据当前进程的控制台 session 与显示器休眠元数据确定 interactive。CLI 窗口可见性、内存压力仍为 `unknown`，不宣称跟踪应用窗口焦点。                                           |

descriptor 实现 Desktop 六项 required：Summary、form-factor、display、input、lifecycle 和事件订阅。其他 operation 声明为 unsupported；当前共享 Broker 会在 Provider I/O 前拒绝这些可选 getter，而不是回退宿主 OS API。

OS 接口参考 Apple 的[显示模式像素 API](https://developer.apple.com/documentation/coregraphics/cgdisplaymode/pixelwidth)和[已注册 IOKit 服务枚举](https://developer.apple.com/documentation/iokit/1514494-ioservicegetmatchingservices)。

`getSummary()` 只含类型固定的 Tier 0/1 字段。每个子字段还必须有自己的字段 Policy，并满足汇总 authority；缺少 grant 时返回 `permissionDenied`、precision `none`、revision 0 且无 value，也不采样该字段。Summary 永不含 Wi-Fi 身份或 Tier 2 state。可选 power 字段只有在独立许可后才显示 unsupported，否则是 permissionDenied。

Display 的 coarse 变换按 100 像素取桶（最小 1），scale 按半档取值并限制在 0.25–16，不返回刷新率。同一 operation 的 Rust 来源 revision 供同步/Promise getter、Summary 和事件共用；仅时间或精度投影变化不会增加它，所以不同获批视图可能具有同一个 revision。

## 事件与重新同步

存在订阅时，以不短于 250 ms 的间隔采样 display/lifecycle 变化。来源事件在所有订阅间共用 Policy 上限；Host 硬上限为 128 个订阅、每秒 128 个来源事件、每订阅队列 256 项。短暂 OS 状态可能被合并。最后一个订阅关闭时会取消其引用型 Host timer，不改变普通 FS watcher 的 `persistent:false` 行为。

收到 `kind: overflow` 后，按 `requiredRevisions` 中的每个 kind 调用独立 getter，再用成功读数的 revision 调用 `acknowledgeResync`。每项都必须达到所需下限，并已从事件或对应 getter 得知；未知未来版本会拒绝。仅 resync 期间可 ACK，确认版本之前的迟到事件不能令状态倒退。display/lifecycle 用 `getDisplay()`/`getLifecycle()` 恢复，不靠更宽的 Summary 权限代替。

真实 macOS 读取、初始 snapshot、队列 overflow/resync、权限与代际/生命周期路径已有可执行证据。验证期间没有主动改变硬件显示/lifecycle，也没有独立观察到物理变化；采样 change 另有受控来源测试，不冒充物理 change 验收。

## Service 安装

受管 Native target 在 owner-only `$HOLONOMY_HOME/native-runtime.json` 额外选择：

```json
{
  "schemaVersion": 1,
  "executablePath": "/absolute/path/to/holo",
  "deviceProvider": { "implementation": "builtin.darwin-device-v1" }
}
```

保持 `0600`，CLI/Service 与二进制使用兼容的开发构建。Service 在启动时读取该 Host 选择，再私有暂存。公开 capability Runtime 请求只提交 Context、初始 Middleware 和 Device Policy，不接受实现选择或原始读数。[受管 Native 配置](managed-engine-gates.zh-Hans.md)给出请求及独立 Service home 的结构；随后用 `holonomy test ./device.test.mjs --target native --capability-runtime ./runtime.json` 执行普通 Guest JS 测试。

修改安装或 Policy 需新建 Runtime／正常重启 Service，插件配置 watch 不能扩大它。generation 关闭会释放订阅与 native callback。普通 OS 读取失败变成 typed reading；私有原生协议损坏则令隔离 generation 失败，不编造 revision，也不默默留下陈旧 iterator。
