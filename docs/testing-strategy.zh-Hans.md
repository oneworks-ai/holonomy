# 测试策略

[English](./testing-strategy.md)

Holonomy 的测试按产品架构分层。每一层只验证自己拥有的契约；最上层验证开发者看到的完整链路，下面各层穷举验证自己负责的代码。

```text
开发者 CLI 端到端场景
  -> CLI 编排层
     -> 平台 Adapter 层
        -> Native Engine Host 或 Native Capability Provider
        -> JavaScript API 层
           -> JavaScript Runtime Kernel 层
```

这是测试责任模型，不是严格的函数调用顺序。真正执行时，Adapter 承载 JavaScript Runtime Kernel，Runtime 安装 JavaScript API，最后执行开发者代码。

## 一、开发者 CLI 端到端层

**要回答的问题：** 开发者把一个 JavaScript 入口交给 Holonomy CLI 后，它能否在选定目标上正常运行并得到结果？

- 入口是 `holonomy run` 和 `holonomy test`。
- 用例放在 `conformance/specs/`，以及少量跨能力场景中。
- 使用真实 CLI、session 打包、目标 Adapter、JavaScript Runtime Kernel 和公共 JavaScript API。
- 只断言开发者可见结果：stdout/stderr、退出码、测试报告、返回值和 fixture 的外部效果。
- 可以使用受控本地 fixture，但不能用 mock 替换产品链路中的某一层。
- 每项能力保留一个代表性成功场景和少量关键失败场景，不复制下层的边界矩阵。

通用用例只写一次，由 Desktop、Android 和未来 Host 原样执行。`.holonomy.<platform>` 只表示有意的平台专属承诺，并单独报告，不进入通用分母。

## 二、CLI 层

**要回答的问题：** CLI 能否把开发者命令正确转换成一个有界 Runtime Session，并收集执行结果？

- 负责参数解析、文件发现、模块图打包、目标/设备选择、ADB 传输与 reverse、CDP 转发、进程生命周期、stdout/stderr 收集和报告渲染。
- 适合使用 fake 或录制的设备、进程、session 端点。
- 不重新测试 `fetch`、timer、Node 模块或 Runtime 调度语义。
- 不读取 Adapter 私有状态，只断言公开的 CLI-to-host 协议和命令结果。

## 三、平台 Adapter 层

**要回答的问题：** 原生 Host 是否在对应平台忠实实现 Runtime/Host 契约？

- 测试跟随 `adapters/<platform>/` 下真正负责实现的模块，不新建一个粗粒度的 Adapter 测试总包。
- 负责 Engine 创建、runtime thread 约束、JSB/NativePort 序列化、generation 身份、Provider 授权、原生 I/O、取消、字节传输、Inspector transport 和销毁。
- 使用最小协议调用或很小的 JavaScript probe 驱动原生边界。
- 不复制完整的 Fetch 重定向矩阵、timer handle 语义等公共 JavaScript API 测试。
- 平台 instrumentation 证明真实 Engine/OS 链路；原生单元测试穷举原生状态、竞态和清理。
- Native Engine Host 按 engine、transport/JSB、lifecycle、Inspector 细分；每个 Native Capability Provider 按 contract、transport、lifecycle、security 细分。
- Android instrumentation 属于 Adapter 集成验证，不是开发者 CLI E2E，因为它没有从 `holonomy run` 或 `holonomy test` 进入。

## 四、JavaScript API 层

**要回答的问题：** 当声明的 Host Port 按契约工作时，Holonomy 的 Node/Web API 语义是否正确？

- 位置是 `__tests__/js-api/<component>/`，跟随对应 `src/` 模块。
- 负责重载、校验、公共状态机、稳定错误、Streams、重定向、编码和 Node/Web 兼容语义。
- 通过公共契约使用确定性的 fake port、clock 和 reference provider。
- 不读取 Android/Javet/JNI/JSB 内部逻辑，也不关心原生 Adapter 怎样实现某个 Port。
- 原生实现错误属于 Adapter 测试；公共 JavaScript 语义错误属于这一层。

## 五、JavaScript Runtime Kernel 层

**要回答的问题：** 与公共 API 和原生 Host 无关的平台中立执行基础是否正确？

- 位置是 `__tests__/js-runtime-kernel/<component>/`，包含 Event Loop、Module Loader、Native Bridge、Resource、Composer 和 Lifecycle 测试。
- 负责调度、模块身份与规划、请求 generation、资源归属、配额记账、dispose 和 Runtime 组合。
- 只使用 Runtime 契约需要的最小确定性 Port。
- 不启动 CLI 进程、不断言 Android 行为，也不重复 JavaScript 层负责的公共 API 语义。
- 这一层由 TypeScript/JavaScript 实现，不是 V8 Native。V8/Javet、Runtime Thread、JSB Transport 和 Inspector 都属于 Adapter 层的 Native Engine Host。

## 具体测试拓扑

```text
__tests__/
  js-runtime-kernel/
    event-loop/
    module-loader/
    native-port/
    runtime-composer/
  js-api/
    fetch 和 network facade/
    node-fs/
    crypto/
    streams/
    timers/
    runtime-console/
    node-test/
    其他公共能力模块/
  cli/
  support/                    # 只放跨 JS 组件共享的测试 fixture

adapters/<platform>/<module>/
  src/test/                   # 原生 unit/contract/lifecycle/security 测试
  src/androidTest/            # 需要真实 Android Engine/OS 时使用

conformance/
  specs/                      # 真实开发者 CLI 端到端用例
```

### Android Adapter 拓扑

Android 测试继续跟随实际 owner，不建立集中式 tests module：

```text
adapters/android/
  host-core/src/test/.../
    contract/                 # Engine Host 契约与稳定错误
    engine/                   # Runtime Thread 和原生调度原语
    lifecycle/                # generation、terminate、wakeup、dispose
    support/                  # 本模块唯一共享 seam
  v8-host/src/test/.../
    engine/                   # V8/Javet 架构与构造
      inspector/              # Inspector 配置和 transport
    lifecycle/                # Native Host generation 与 restart/close
  network-host/src/test/.../
    contract/                 # NativePort schema、authority、resource binding
    transport/                # DNS snapshot、socket/TLS、HTTP framing 与字节传输
    lifecycle/                # cancel、deadline、watchdog、close/dispose
    security/                 # private network、managed input、quota
    support/                  # Provider 测试唯一共享 seam
  e2e/src/androidTest/.../
    engine/                   # 真实 Android Engine 组合
      transport/              # 真实 NativePort transport
      inspector/              # 真实 Inspector socket
    session/lifecycle/        # Android Session 取消与清理
    session/security/         # Android Session 输入/输出限额
```

`pnpm test:adapter:android:unit` 聚合三个原生 JVM 模块；`pnpm test:adapter:android:device` 显式复用设备 instrumentation，不自动进入 `pnpm test`。Instrumentation 直接启动 Android Adapter，而不是从 CLI 进入，因此只能作为 Adapter 集成证据。

`pnpm test:e2e:android` 是独立的开发者端到端门禁。它执行真实的 `holonomy test "conformance/specs/**/*.test.mjs" --target android` 链路，并且有意不进入默认的 `pnpm test` 单元测试聚合。

当前 `RuntimeCompositionInstrumentationTest` 仍保留一条较宽的 Composer/模块规划/Event Loop/NativePort/销毁 smoke。它暂时承载真实 V8 装配下的唯一组合回归证据；只有对应的下层测试和更小 instrumentation probe 提供等价证据后，才应继续收窄，不能在本次物理分类中凭推断删除断言。

三个 Vitest 集合由路径决定，必须互不相交且覆盖全部 `*.spec.ts`。`pnpm test:topology` 会拒绝落在三层之外的 spec。分别使用 `pnpm test:runtime`、`pnpm test:js`、`pnpm test:cli`；`pnpm test` 保持聚合门禁。

Fetch 和文件系统能说明 JS/Native 如何分工：

| 能力       | JavaScript API 负责                                                             | Native Provider 负责                                                                |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Fetch      | `Request`、`Response`、`Headers`、redirect、abort 和 body stream 语义           | DNS、地址授权、socket/TLS、transport byte、原生取消和清理                           |
| Filesystem | Node overload、virtual path、flag/encoding、callback/Promise 行为和稳定公共错误 | root 授权、真实文件操作、handle identity、atomic replace、quota、取消和路径逃逸保护 |

任何一边都不测试另一边的私有实现。

## 层间契约

每条边界只设一个契约 owner：

| 边界                                       | 契约 owner                          | 实现方需要证明的内容                   |
| ------------------------------------------ | ----------------------------------- | -------------------------------------- |
| CLI ↔ Host Process                         | CLI/Session Protocol                | 能够接收并完成有界通用 Session         |
| Adapter ↔ Runtime                          | Runtime Host/NativePort Contract    | 线程、传输、身份、取消和清理正确       |
| JavaScript API ↔ Host Capability           | JavaScript Capability Port          | Adapter 满足 Port；JS 测试负责公共语义 |
| JavaScript Runtime Kernel ↔ JavaScript API | Runtime Composition/Module Registry | API 按声明的模块或全局名称安装并可访问 |

多个 Adapter 实现同一个契约时，由边界 owner 维护一套可复用 contract suite，各 Adapter 用自己的实现运行它；不要复制用例。

## 怎样判断是否重复

同一项能力可以出现在多层，但每层必须回答不同的问题。例如：

- JavaScript Runtime Kernel：带 credit 的 Native Completion 只交付一次。
- JavaScript API：`fetch()` 暴露正确的流式 `Response` 语义。
- Android Adapter：原生 HTTP Provider 正确处理 credit、取消和 socket 清理。
- 开发者端到端：`holonomy run fetch.mjs --target android` 得到预期 body 和退出码。

这不是重复建设。把完整的 Fetch header、redirect、cancel 矩阵复制到四层才是重复建设。

每次处理回归时：

1. 在包含缺陷的最低责任层加入穷举用例。
2. 只有对应上层边界或开发者链路也缺少保护时，才再补一个上层回归。
3. 不能只用 E2E 保护下层状态机缺陷。
4. 不能为了重复公共语义，在低层再造一份相同断言。

## 用例和报告规则

- 开发者 Conformance 文件使用标准 `node:test` 和 `node:assert/strict`。JavaScript `node:test` 实现只负责注册、hook、执行和结构化 `TestRunSummary`；TAP/JSON 只由 CLI 渲染。
- 通用 E2E 必须确定、有界且不依赖公网服务。
- 通用能力缺失必须失败，不能 capability auto-skip。
- fixture 只有一个 owner；CLI 负责 ADB、CDP、设备选择、本地 fixture 生命周期和环境注入。
- 时间和竞态用受控 clock、transport 或 latch，不依赖随意 sleep。
- 所有已准入资源都必须完成或在 `finally` 中释放。
- 各层结果分别报告。只有普通通用 E2E 进入跨平台能力覆盖率分子/分母；平台专属、CLI、Adapter、JS 和 Runtime 测试都是独立证据。

## Review 清单

接受新用例前确认：

1. 这个行为属于五层中的哪一层？
2. 断言是否只涉及该层公开契约？
3. 同一层是否已有用例证明相同结果？
4. 如果是 E2E，它是否证明完整开发者链路，而不是内部实现分支？
5. 如果不是 E2E，它能否不启动上层组件独立运行？
6. fixture、资源、deadline 和诊断是否确定并完整清理？
