# 在 Android 上运行

[English](../en/getting-started/run-on-android.md)

Android target 在宿主应用的 foreground Supervisor 中创建受管逻辑 V8 Runtime。Service 负责设备选择、APK、ADB lease、日志和 Inspector 生命周期。

## 前置条件

- Android SDK 与 ADB 可用。
- 一台状态为 `online` 的 Android 模拟器或物理设备。
- 当前证据必须明确区分 `emulator` 与 `physical`。

查看设备：

```sh
pnpm holonomy device list
```

## 运行第一个程序

```sh
pnpm holonomy run examples/basic.mjs \
  --target android \
  --device emulator-5554
```

替换为明确选定的设备 ID。多设备在线时不要依赖隐式选择。

## 运行带网络的测试

```sh
pnpm holonomy test "conformance/specs/**/*.test.mjs" \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --reporter json
```

Service 会在 Runtime 启动前完成受控 fixture 和精确网络 authority 的 staging。

## 打开 DevTools

```sh
pnpm holonomy test conformance/specs/fetch.test.mjs \
  --target android \
  --device emulator-5554 \
  --sandbox conformance/sandbox/restricted.json \
  --inspect-brk \
  --devtools
```

结束后停止或移除对应进程。不要用通用 `adb force-stop` 代替进程级生命周期操作。

下一步：[Android 平台说明](../platforms/android/index.md) · [DevTools 调试](../guides/debug-with-devtools.md)
