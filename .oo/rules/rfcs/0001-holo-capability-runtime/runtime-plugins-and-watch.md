# RFC-0001 附录 K：Cordis Runtime Plugin、资源包与 Watch

[返回 RFC 总览](../0001-holo-capability-runtime.md)

本附录冻结完整插件目标，并区分当前证据：Node/Desktop CLI 已支持配置装载与 watch graph replacement，Android v1 仅支持启动时静态 Bundle；Capability Middleware graph snapshot、drain 与 Permission/Audit 基础合同仍属于 M3 Exit。每个 Runtime generation 拥有一个 Cordis App；Cordis 管理 JavaScript 插件的 Context、依赖与 dispose，Holonomy Kernel 继续拥有 Policy、Broker、资源、authority、generation 和终态安全。

## K.1 代码与包边界

目标 workspace 依赖方向如下：

```text
packages/runtime              # Kernel + Cordis App
packages/capability-*         # fs/network/device/system/process
packages/plugin-*             # permission/audit 等可选基础插件
adapters/*                    # Node/Desktop/Android Provider 与 Bridge
tools/cli                     # 参数与 Host 请求入口
tools/service                 # 配置、资源和 Runtime 长生命周期 owner
```

`capability-*` 与 `plugin-*` 可以依赖 `runtime` 的公开 Host contract；`runtime` 不得反向依赖具体 capability/plugin。官方 Capability、Permission、Audit、接入方规则与自定义 Provider 都采用 JavaScript/Cordis plugin packaging。包名前缀只表达角色，不授予 authority。

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
  readonly bytes: Uint8Array
}

interface RuntimePluginBundleV1 {
  readonly schemaVersion: 1
  readonly instanceId: string
  readonly rootUrl: `holo-plugins:///${string}/`
  readonly entryUrl: `holo-plugins:///${string}`
  readonly bundleSha256: string
  readonly exportName?: string
  readonly config: JsonValueV1
  readonly files: readonly RuntimePluginFileV1[]
}
```

`instanceId` 在一份配置内唯一且有界。Loader 必须验证所有 URL 位于 exact `rootUrl`、entry 属于 files、文件 URL 唯一、SHA-256 与 exact bytes 相符、模块图不逃逸 root。Runtime 只消费 Bundle，不识别 npm、pnpm、绝对路径或 symlink。

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

系统 Policy、snapshot、authority、resource fencing 不是可装卸用户插件。配置插件运行在可信 Host plugin realm，Guest 无法取得 Cordis Context，也不能加载、枚举、排序或 dispose 插件。每个插件使用独立 Cordis child Context；注册必须通过 Context/effect 生命周期完成，ambient global side effect 不属于合规插件合同。

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

Android v1 只支持启动时静态 Bundle：Native Host 在 Guest entry 前生成只读 plugin manifest，Runtime 使用同一 Cordis App 完成 install。Android 不接受动态 graph replacement，CLI 对 Android `--watch` 稳定拒绝；这不是第二套插件 API。

## K.6 固定验收

- package、相对路径、允许/拒绝的绝对路径产生等价 Bundle identity；Runtime 看不到 Host path；
- `holo-plugins:///` root escape、重复 URL、错误 bytes digest、entry 缺失和 module graph escape 全部拒绝；
- 初始 plugin staging 失败时 Guest entry 副作用为零；
- invalid JSON/Schema、重复 ID、config validation/import/apply 失败不改变 active revision；
- add/remove/change/reorder/disable 只作用于预期实例，unchanged scope 不 reload；
- in-flight invocation 使用旧 graph exactly once，新 invocation 使用新 graph，drain 后 dispose exactly once；
- Runtime restart/stop 使所有 plugin graph revision、资源、callback 和 late result 失效；
- Node/Desktop CLI watch 与 Android static Bundle 使用同一 loader vectors；不存在 Native plugin fallback。
