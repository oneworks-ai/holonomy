# Android 网络 Provider

[English](./README.md)

`network-host` 提供 Android 原生 `host.network.http` 能力。它负责 authority 校验、请求配额、
DNS 准入与 pin、socket/TLS 传输、取消、资源归属、流式 credit 和销毁。JavaScript Fetch 语义
仍由 JavaScript web-standards 层负责。

## 默认 Provider

每个逻辑 runtime generation 创建一个 provider，并把返回的 `RuntimeNativeHost` 交给该
generation 的 engine composition：

```kotlin
val factory = AndroidNetworkProviderFactory.default(
    configuration = AndroidNetworkHostConfiguration(
        principal = "app-runtime",
        allowedOrigins = setOf("https://api.example.com"),
    ),
)

val nativeHost = factory.create(
    AndroidNetworkProviderGeneration(runtimeId = "worker-a", generation = 1),
)
```

每次 `create` 都必须返回全新 host。若同一个 provider 实例被跨 generation 复用，factory
会 fail closed，避免资源、取消或销毁越过 generation 边界。

## 只读观测

可信 embedder 可以接收异步摘要，但不会获得 provider 控制能力：

```kotlin
val factory = AndroidNetworkProviderFactory.default(
    configuration = networkConfiguration,
    observation = AndroidNetworkObservationConfiguration(
        observer = AndroidNetworkObserver { summary ->
            diagnostics.record(summary.kind, summary.terminalState, summary.elapsedMs)
        },
        maxPendingObservations = 64,
    ),
)
```

摘要只包含 runtime generation、exchange sequence、origin、method、status、字节数、耗时和
稳定的 terminal state/error；不会暴露 path、query、header、body、DNS 地址或 transport
对象。投递使用有界异步队列：队列溢出时丢弃观测，observer 抛错会被隔离，慢 observer
不会反压请求。
provider 关闭时会清空待投递摘要并释放 observer 引用；已经运行的回调可以返回，但排队中的
回调不会在 close 后启动。

## 可信替换

需要替换传输策略的 embedder 必须提供完整 provider：

```kotlin
val factory = AndroidNetworkProviderFactory.replacement { generation ->
    CompanyNetworkProvider(generation)
}
```

replacement 自身就是 provider owner，必须完整实现 `RuntimeNativeHost` 契约，并继续负责
authority、quota、DNS pin、资源绑定、取消、流式 credit 和销毁。内部 socket、TLS、resolver
和 worker seam 不作为公开扩展点。观测配置只适用于默认 provider；replacement 需要自行保证
诊断旁路的安全性。
