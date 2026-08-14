# RFC-0001：设备信息与文件系统

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 14. `holo:device` 标准

### 14.1 模块边界

`node:os` 已有的 CPU、架构、内存、uptime、hostname、userInfo 和原始 network interface 形态继续属于 `node:os`。它们不直接读取 ambient OS，而只消费 Host 创建 generation 时冻结的逐字段系统投影；真实、合成、脱敏和不可用模式见[附录 C](host-system-projection.md)。`holo:device` 不重复创建这些 Node API。

`holo:device` 只拥有 Node 没有统一标准的设备状态：

| 分组           | 典型信息                                                                           |
| -------------- | ---------------------------------------------------------------------------------- |
| `formFactor`   | phone、tablet、desktop、server、tv、wearable、automotive、unknown                  |
| `connectivity` | online、validated、transport、metered、roaming、captive portal、质量与可选信号摘要 |
| `power`        | 是否有电池、电量、充电状态、电源类型、低电量模式                                   |
| `display`      | 尺寸、density scale、刷新率、方向、HDR、wide color                                 |
| `input`        | touch、最大触点、pointer、hover、键盘、鼠标                                        |
| `thermal`      | nominal、fair、serious、critical 等级                                              |
| `media`        | camera、microphone、speaker 能力，不枚举敏感设备名                                 |
| `sensors`      | accelerometer、gyroscope、barometer、light 等能力清单                              |
| `security`     | secure storage、hardware key、biometric、device lock 能力摘要                      |
| `lifecycle`    | foreground/background、interactive、memory pressure                                |

`holo:device` v1 的导出、精确类型、单位、枚举、隐私级别、operation、事件和平台 availability 由[附录 D](device-schema-v1.md)定义；本节分类表不能替代该 Schema。

### 14.2 可用性

不能用 `null` 混淆不支持、拒绝和脱敏。`available`、`redacted`、`unsupported`、`unavailable` 与 `permissionDenied` 的 value/precision组合只由[附录 D 的 `DeviceReadingV1`](device-schema-v1.md)判别联合定义；说明章节不得另建loose `{status,value?}` 类型。

### 14.3 调用而不是静态敏感属性

需要逐次拦截或异步授权的数据必须使用方法：

```ts
const wifi = getWifiState()
```

普通模块初始化时复制的属性无法在每次读取时执行异步 Host Middleware。稳定快照可以在模块创建时拦截一次；动态敏感值使用 getter method 或 Promise method。

逐次读取必须使用附录 D 的 exact `DeviceOperationV1`，例如 `device.connectivity.wifi.state.read`、`device.connectivity.wifi.identity.read` 和 `device.events.subscribe`。不存在 `connectivity.summary`、`wifi.signal`、`power.summary` 或 `display.summary` alias。

Wi-Fi 状态、SSID/BSSID 和实际网络连接权限必须分开。允许读取连接状态不代表允许 HTTP 请求。

### 14.4 默认隐私

Guest 默认不得获得：

- IMEI、设备序列号、MAC、Android ID；
- SSID/BSSID、SIM、运营商、基站信息；
- Host 路径、ADB serial、AVD owner nonce、真实 PID；
- 已安装应用、账户、剪贴板或原始传感器流。

这些能力若未来存在，必须拥有独立 operation、Sandbox capability、Provider 和 Host Middleware 上下文。

### 14.5 动态事件

动态状态通过 `holo:device/promises` 的有界订阅提供，事件值必须是附录 D.1 的 discriminated union，不允许 `kind:string` 配合 `value:unknown`。overflow携带受影响kind的required revisions；消费者逐kind调用对应getter并重新经过Policy/Middleware，不能用Tier 1 summary恢复Tier 2。慢消费者不得阻塞平台callback。

## 15. 文件系统拦截

文件系统继续使用 `node:fs` 和 `node:fs/promises`。典型 operations：

```text
filesystem.file.read
filesystem.file.write
filesystem.file.open
filesystem.file.close
filesystem.metadata.stat
filesystem.metadata.lstat
filesystem.directory.read
filesystem.directory.create
filesystem.entry.rename
filesystem.entry.unlink
filesystem.watch.subscribe
filesystem.watch.close
```

Interceptor 负责业务授权，Filesystem Provider 负责真实文件安全。Provider 必须：

- 只接受规范化虚拟路径；
- 在 Sandbox root 内执行 handle-relative 安全打开；
- 明确拒绝或受控处理 symlink；
- 防止授权后 path swap/TOCTOU；
- 对打开的句柄绑定 principal、generation 和 rights；
- 限制单次、单句柄和总字节；
- restart、撤销或 dispose 后使旧句柄失效；
- 永不把原生路径和平台错误暴露给 Guest。

Sandbox root、rights、symlink mode 和句柄/字节/watch 限额由附录 A 的 `filesystem` Policy 冻结。Middleware、Grant key 和 Provider 必须共享附录 B 的同一个 canonical filesystem identity；Provider 仍以 handle-relative 方式重验 resolved resource，不得重新把 Guest 原始字符串当作授权依据。

公开 `node:fs`/`node:fs/promises` v1 capability matrix、options、Stats/Dirent/FileHandle、atomicity、watch 与 unsupported 行为由[附录 H](filesystem-schema-v1.md)冻结。本节 operation 列表不能被解释为“任意子集都算生产 Provider”。
