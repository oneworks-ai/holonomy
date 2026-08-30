# RFC-0001 附录 K：Cordis Runtime Plugin、资源包与 Watch

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录冻结完整插件目标，并区分当前证据：Node/Desktop CLI 已支持配置装载、Capability Middleware graph snapshot/drain 与 watch graph replacement；Permission/Audit 提供官方基础组件，但具体决定和存储仍由应用注入。Android v1 支持启动时静态、同步 Bundle，并在独立 Host plugin realm 中把同步 Capability Middleware 接入同一 Broker；动态 replacement 仍不支持。Holonomy Kernel 始终拥有 Policy、Broker、资源、authority、generation 和终态安全，Cordis 只管理已准入 JavaScript 插件的 Context、依赖与 dispose。

## K.1 代码与包边界

目标 workspace 依赖方向如下：

```text
packages/runtime              # Kernel + Cordis App
packages/capabilities/*       # fs/network/device/system/process
packages/plugins/*            # permission/audit 等可选基础插件
adapters/*                    # Node/Desktop/Android Provider 与 Bridge
tools/cli                     # 参数与 Host 请求入口
tools/service                 # 配置、资源和 Runtime 长生命周期 owner
```

Capability 与 plugin 包可以依赖 `runtime` 的公开 Kernel contract；Capability Provider 实现不得进入 Runtime Kernel。当前 `@holonomyjs/runtime` 同时是默认组合入口，因此它显式依赖官方 Capability 包来生成内置 Registry 与 Facade；这是 composition dependency，不允许 Capability 包访问 Runtime App 实例或形成第二套生命周期。若接入方只需要叶子合同，可以直接导入 `@holonomyjs/runtime/kernel/*` 与对应 Capability 子路径。官方 Capability、Permission、Audit、接入方规则与自定义 Provider 都采用 JavaScript/Cordis plugin packaging。包名前缀只表达角色，不授予 authority。

Native Host 不实现第二套插件 API。Android/Desktop Embedder 只负责加载资源字节、构造 Resource Manifest、提供 Native Bridge，并创建/停止 Runtime。Native 权限窗口等平台行为通过 Bridge service 暴露，由 JavaScript Permission plugin 调用。

## K.2 Plugin Resource Bundle

插件资源使用独立的 hostless hierarchical scheme：

```text
holo-plugins:///<plugin-instance-id>/<relative-path>
```

不得使用 `holo:///plugins/*`、`file:` 或 Host 原生路径作为 Runtime 内的插件 identity。`holo:///runtime/*` 只属于随 Runtime 发布的不可变内部资产。

```ts
interface RuntimePluginFileV1 {
  readonly url: `holo-plugins:///${string}`
  readonly sha256: string
  readonly source: string
}

interface RuntimePluginBundleV1 {
  readonly schemaVersion: 1
  readonly instanceId: string
  readonly rootUrl: `holo-plugins:///${string}/`
  readonly entryUrl: `holo-plugins:///${string}`
  readonly bundleSha256: string
  readonly exportName: string
  readonly config: JsonValueV1
  readonly files: readonly RuntimePluginFileV1[]
}
```

`RuntimePluginBundleV1` v1 是严格 UTF-8 JavaScript source-only 合同，不承载任意二进制资源。`source` 必须是 Unicode scalar text，禁止未配对 surrogate；它编码后的 UTF-8 字节必须不超过 8 MiB，单个 Bundle 的全部 source 不超过 32 MiB，files 最多512项。`sha256` 对这份 exact UTF-8 bytes 计算；Host transport 使用 JSON string，不能再次 base64、换行归一化或替换非法字符。非 UTF-8 源文件在 Host source resolution 阶段稳定拒绝。

`instanceId` 在一份配置内唯一且有界。Loader 必须验证所有 URL 位于 exact `rootUrl`、entry 属于 files、文件 URL 唯一、SHA-256 与 exact UTF-8 bytes 相符、模块图不逃逸 root。Runtime 只消费 Bundle，不识别 npm、pnpm、绝对路径或 symlink。若未来插件需要二进制资源，必须用新的 Bundle schemaVersion 和显式 binary discriminant，不能在 v1 中把 source 字符串解释为任意字节。

## K.3 Host 配置与来源解析

```ts
interface HoloPluginConfigEntryV1 {
  readonly id: string
  readonly use: string
  readonly export?: string
  readonly enabled?: boolean
  readonly config?: JsonValueV1
  readonly integrity?: string
}

interface HoloConfigV1 {
  readonly plugins?: readonly HoloPluginConfigEntryV1[]
}

interface RuntimePluginPackageManifestV1 {
  readonly kind: 'runtime-plugin'
  readonly apiVersion: 1
  readonly entry: string
  readonly configSchema?: string
}
```

npm 包通过 `package.json.holo` 提供该 manifest；resolved `entry` 或具名 `export` 必须是 Runtime Cordis App 可安装的 JavaScript plugin。`plugins` 缺省为空数组；`enabled` 缺省为 true；`export` 缺省为 default；`config` 缺省为空对象；`integrity` 是可选的调用方 pin，Service 始终计算 Bundle integrity，并在提供 pin 时要求精确匹配。

`use` 接受三类 Host 来源：package specifier、以 `./` 或 `../` 开头的相对路径，以及平台绝对路径。其他字符串按 package specifier 解析，v1 不接受 `file:` URL。package 从配置所属 workspace 解析；相对路径以 `holo.config.json` 所在目录为基准；绝对路径必须由 Host policy 显式允许。`run` 不在启动或 watch 时联网安装依赖。Service 解析 real path、manifest、config Schema、依赖闭包和 integrity 后才生成 Bundle，且不得把原生路径写入 Guest、CDP、日志或 Bundle URL。

可信启动侧负责资源准备：本地 CLI 从配置所属 workspace 解析文件，Native Host 可以从 APK assets 或自己的受控存储读取；两者都只向 Service 提交不含 Host path 的 `RuntimePluginBundleV1`。Service 不读取调用方文件系统，只拥有 Bundle 准入、revision CAS 与 Runtime transaction。跨平台只有资源准备和静态/动态装载能力不同，不存在 Native plugin fallback。

## K.4 Cordis App 与插件图

Runtime 创建顺序固定为：

```text
Kernel system controls
  → official capability/provider resources
  → Host configured plugin resources in array order
  → freeze initial plugin graph
  → Guest entry
```

系统 Policy、snapshot、authority、resource fencing 不是可装卸用户插件。配置插件运行在可信 Host plugin realm，Guest 无法取得 Cordis Context，也不能加载、枚举、排序或 dispose 插件。Host plugin realm 与 Guest realm 不共享 global、intrinsics 或模块实例；插件对 ambient global 的写入既不属于合规插件合同，也不得在 Guest 中可见。

Node/Desktop v1 使用 generation-owned `HolonomyRuntimePluginAppV1`。每个插件获得独立 Cordis child Context；注册必须通过 Context/effect 生命周期完成，可以异步初始化。Runtime 把 Cordis Context 的 Holo interception service 绑定到该 generation 的 Capability graph，发布新 revision 时冻结 invocation snapshot，旧 revision drain 后才 dispose。官方 Permission/Audit 包只提供拦截协议、decider/sink 注入点和默认安全行为，弹窗、允许一次/长期允许、持久化和审计目的地都由接入应用决定。

Android v1 使用独立、Host-owned 的 Javet/V8 plugin realm，并为每个静态插件创建新的 Cordis Context。它只允许同步初始化、同步 Middleware 和同步返回的 disposer；返回 Promise、注册 async Middleware 或其他异步初始化结果会使 generation 在 Guest entry 前稳定失败。Host plugin realm 在 Guest entry 前发布 revision 1 的冻结 Capability graph；真实 facade 调用通过该图进入同一 Broker，插件 global/intrinsics 不进入 Guest。Android v1 按整个 Host plugin realm 关闭插件，不提供 live graph replacement，也不能被描述为 Node/Desktop 完整 Cordis App 的平台等价实现。

## K.5 `watch` 模式

CLI 入口为：

```text
holonomy run app.mjs --config holo.config.json --watch
```

Node/Desktop CLI watcher 对 rename/write 事件去抖后总是重新读取完整文件，不依赖单个文件系统事件的语义。每个候选 revision 必须先完成 JSON parse、HoloConfig Schema、唯一 ID、插件 config Schema、source resolution 和 Bundle integrity，再由 Service 做 revision CAS、Runtime staging import/apply；任何一步失败都发出有界 diagnostic，并保持 last-known-good plugin graph 完全不变。配置缺失或被删除不等于空数组；卸载全部插件必须显式写入合法的 `plugins: []`。

diff 以稳定 `id` 和数组顺序为准：

- 新 ID：stage 后安装；
- 删除或 `enabled:false`：从下一 graph revision 移除；
- `use/export/config/integrity` 变化：stage replacement，再卸载旧 scope；
- 顺序变化：产生新的有序执行图，不能继续沿用旧 Middleware 顺序；
- 未变化：不得触发 dispose/reload。

提交采用两阶段事务：所有新增/替换 scope 在隔离 Cordis child Context 中 staging；全部 ready 后原子发布递增的 `pluginGraphRevision`。新调用只使用新 graph snapshot；已开始调用继续使用旧 snapshot，完成或达到 Host drain deadline 后旧 scope 才 dispose。removed/replaced scope 拥有的资源、订阅和 Bridge binding 在 dispose 时关闭，迟到 terminal 受 graph revision 与 Runtime generation 双重 fencing。

v1 watch 只承诺配置与重新解析后的 Bundle diff，不承诺任意模块源码 HMR。若非 `plugins` 配置变化需要 Runtime restart，Service 必须明确报告，不能部分静默应用。

Android v1 只支持启动时静态 Bundle：Native Host 在 Guest entry 前生成只读 plugin manifest，独立 Host plugin realm 按 K.4 的同步子集完成 install。Android 不接受动态 graph replacement，CLI 对 Android `--watch` 稳定拒绝；这不是第二套插件 API，也不允许回退为 Guest realm 插件。

## K.6 固定验收

- package、相对路径、允许/拒绝的绝对路径产生等价 Bundle identity；Runtime 看不到 Host path；
- `holo-plugins:///` root escape、重复 URL、错误UTF-8 digest、非法UTF-8/未配对surrogate、byte limit、entry缺失和module graph escape全部拒绝；
- 初始 plugin staging 失败时 Guest entry 副作用为零；
- invalid JSON/Schema、重复 ID、config validation/import/apply 失败不改变 active revision；
- add/remove/change/reorder/disable 只作用于预期实例，unchanged scope 不 reload；
- in-flight invocation 使用旧 graph exactly once，新 invocation 使用新 graph，drain 后 dispose exactly once；
- Runtime restart/stop 使所有 plugin graph revision、资源、callback 和 late result 失效；
- Node/Desktop CLI watch 与 Android static Bundle 使用同一 loader vectors；不存在 Native plugin fallback；
- Android Host plugin global/intrinsics 对 Guest 不可见，插件先于 Guest entry 安装；
- Android 同步插件至少拦截一个真实 facade 调用，并保持 Policy、Provider authority 与 Guest 结果语义；
- Android 插件返回 Promise/异步初始化时 generation 启动失败，Guest entry 副作用为零。
