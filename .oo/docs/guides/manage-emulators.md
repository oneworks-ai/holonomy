# 管理 Android 模拟器

[English](../en/guides/manage-emulators.md)

Holonomy Service 只管理由自己启动且 owner 证据仍然匹配的 AVD。物理设备和外部启动的模拟器可以出现在设备清单中，但不能通过 Holonomy stop 或 restart。

## 查看清单

```sh
pnpm holonomy emulator list
pnpm holonomy device list
```

Emulator 资源表示受管 AVD 生命周期；Device 资源表示当前观察到的 ADB endpoint。两者不是同一个资源。

## 启动

```sh
pnpm holonomy emulator start Pixel_8_API_35 --wait
```

`--wait` 会等到设备可用。保存返回的 emulator ID；后续生命周期操作使用这个稳定 ID，而不是猜测 launcher PID。

## Restart 与 Stop

```sh
pnpm holonomy emulator restart <emulator-id> --wait
pnpm holonomy emulator stop <emulator-id>
```

Service 会同时核验持久化 owner 记录、AVD 名、serial、launcher PID 和随机 nonce。证据缺失、PID 被复用或设备属于外部进程时会 fail closed，不会尝试 kill。

普通 `service stop` 在仍有受管模拟器时返回冲突。只有显式 `service stop --drain` 才会连同当前 Service 拥有的模拟器一起清理。

设备与模拟器 HTTP 资源见 [OpenAPI](../openapi/index.md)。
