# Holonomy 原生桌面端

[English](README.md)

独立的 `holo` 可执行文件通过 Rust 和 `rusty_v8` 嵌入 V8，内部携带共享 Holonomy JavaScript Runtime，执行时无需安装 Node.js。原生桌面目标仍在开发，目前真实验证的平台为 macOS arm64。

安装 Rust 1.94.1 和仓库 pnpm 依赖后，在仓库根目录构建：

```sh
pnpm build:native
./target/release/holo ./index.js
./target/release/holo --timeout 5000 ./index.mjs argument
./target/release/holo test ./conformance/specs/timers.test.mjs
./target/release/holo engine info --json
```

Node 和 esbuild 仅参与构建。复制 `target/release/holo` 后，不需要源码目录或 `node_modules` 即可执行。

当前已接通 CommonJS `.js`/`.cjs`、ESM `.mjs` 和 package `type: module`、静态与动态 import、顶层 await、require JSON、共享纯 JS `node:*` 模块、console、timers 和 `node:test`。模块读取始终限制在选定源码根内（默认是入口目录）；仅跟随 `node_modules` 下目标仍在根内的相对包目录链接，普通文件链接、绝对链接和越界目标仍拒绝。解析继续使用现有 Holonomy Module Loader；不宣称完整 npm、Node 或原生 addon 兼容。

Host 明确选择了带嵌套入口的项目时，可用 `holo --module-root ./project ./project/src/index.js`。兄弟模块与包查找仍限于该目录，虚拟身份是 `app://workspace/src/index.js`。`holo test --module-root ./project ./project/tests/a.mjs ./project/tests/b.mjs` 会在首个用例执行前检查全部文件边界。这个参数不授予 `node:fs`、不改变 Guest cwd、不自动向上发现更大的项目，也不公开私有 Host 文件。不传时保留入口目录边界；放在入口后面则只是 Guest argv。

CommonJS 的 `require('node:assert/strict')` 与 `require('node:test')` 可直接调用，`require('node:process')` 与全局 `process` 是同一对象。ESM 命名导出仍保留独立的数据快照语义。

`process.nextTick(callback, ...args)` 已复用既有 Runtime Event Loop，返回 `undefined`，保留参数身份、FIFO 和嵌套顺序；非法回调同步报 `ERR_INVALID_ARG_TYPE`。直接 CommonJS 入口的 tick 先于 Promise job，ESM 入口的 Promise job 先于 tick；timer 回调中的 tick 先于该回调的 Promise job。仅 tick 检查点不会推进已就绪 timer。递归 tick 仍受 Runtime 回调预算与执行期限约束，不宣称 Node 无界饥饿行为。

全局与 `node:timers` 的 `setImmediate`/`clearImmediate` 使用同一个循环。Immediate 句柄保留回调 `this` 与参数身份，提供 `ref`/`unref`/`hasRef`，并在引擎提供相应 Symbol 时支持 `[Symbol.dispose]` 取消；每个回调都有独立的 tick/Promise 边界，嵌套 Immediate 留到后续批次。仅有未引用 Immediate 时，可执行文件会自然退出。这是有界 check 批次模型，不宣称与完整 libuv poll/I/O 相位等价。

回调、入口和未处理拒绝的致命诊断读取有界原生 Error 数据，不读取 Guest `stack`，也不调用强制转换或格式化钩子。Proxy、message 访问器和不安全值使用固定回退文本。虚拟位置绑定到准入编译时记录的 V8 Script ID，不相信 Guest `sourceURL` 名称；未知 ID 或诊断元数据已满时省略位置，不阻断执行。注册表最多保留 4,096 个、不超过 512 字节的 URL，原生栈最多捕获 32 帧；不保证完整原始栈或与 Node 完全相同的错误文案。

未处理拒绝会先允许 Promise job 与已有 nextTick 阶段附加处理器，再在下一个普通 timer 前裁决。直接 CommonJS 同步失败不执行已排队 job；独立 ESM 失败可能先执行更早的 Promise job。配置了 Host 时，清理阶段仍禁止 Guest 重入。

JavaScript `holonomy run/test --target native` 前端会先使用 owner 安装的本地 Rust 源读取器，再联系 Service。原生描述符相对读取会先登记选中的 Host 配置、插件和 token 身份，再收集 Guest 图；同文件、硬链接跨角色发布会拒绝。CLI 配置 watch 保留同一读取器租约，已读 Guest 源不能被提升为 Host 插件。定位二进制的安装文件仍通过有界 Host bootstrap 读取；源码和插件代码字节不会回退到 Node 文件读取。

共享解析器把包 imports/exports、JSON 与实际读到的 package 元数据收集为有限源码快照。根内 pnpm 包链接返回规范虚拟 URL，后续依赖查找与模块唯一身份按真实包位置处理。Service 只暂存规范文件，并校验有界、非链式的别名表；图摘要与私有精确 URL allowlist 覆盖别名两端。Opaque 内建引用不是伪造绑定，真实 Native Runtime 仍校验可用性、导出名与准入。运行期计算出的 import 只能到达已捕获集合。Native `run` 保留真实 CJS/ESM 主入口，也支持嵌套入口；执行工作区由 Service 私下派生，不是公开 Host 路径参数。Query 和空 fragment 身份仍分别成模块；同一物理暂存路径若对应不同字节，会拒绝准备。

CommonJS 已支持 `require.main === module`、`module.id`/`filename`/`loaded` 和已规划的 `require.resolve()`；文件名与解析结果始终为规范虚拟 URL，不是 native 路径。Resolve 不执行目标，也不授予新的装载权限；别名 require 若尝试执行仅 resolve 的边，会以 `ERR_HOLONOMY_MODULE_DYNAMIC_REQUIRE_UNSUPPORTED` 拒绝。尚不支持 `require.cache`、额外 resolve 搜索路径或完整的 Node Module 对象。

`holo test a.test.mjs b.test.mjs` 接受 1–256 个显式文件，先检查所有输入，再按顺序为每个文件创建独立 Runtime；每个文件输出一行 JSON 报告，任一失败使最终退出码非零。`--timeout` 是所有文件共用的总期限，尚不提供自动发现或内建 glob。测试未完成前调用 `process.exit(0)` 不算通过；普通 `holo index.js ...` 的应用参数与退出行为不变。

`package.json#imports` 已支持私有 `#alias`、单星号模式、按声明顺序选择的嵌套 `import`/`require`/`default` 条件、数组/null 和外部包目标。最近的 package 拥有自己的映射，查找不跨越 `node_modules` 边界；包自身的 `name`/`exports` 引用也复用同一个解析器。例如：

```json
{
  "type": "module",
  "imports": {
    "#internal": "./src/internal.mjs",
    "#feature/*": "./src/features/*.mjs",
    "#dependency": "dependency/subpath",
    "#path": "path"
  }
}
```

imports 和显式 exports 选择精确 URL，不隐式补扩展名或目录 index。真实无扩展名 JavaScript 目标按最近 package 的 `type` 分类；其他未支持格式和原生 addon 仍拒绝。裸内建名称只映射到 Host 已声明的精确 `node:*` 模块；映射目标不能写字面量 `node:path`，应使用 `path`。条件按清单键顺序而非预设优先级选择，Holonomy 的固定 production/source profile 不开放任意 Node 自定义条件。

包链接只是源码导航事实，不增加文件系统权限；请求路径与解析后源都继续检查私有名称空间和 inode 身份。自包含 Host 插件包另用私有固定包根读取器接入根内 pnpm 安装；配置/token 及包内叶文件仍不跟随链接。指向选定根外 store 的 workspace 链接不支持，也不会自动扩大根或安装依赖。模块规划失败显示安全公共错误码；动态 import 在接收方 Guest realm 创建具有自有 `code` 的 Error，不传递私有 Planner Error，也不复制原生路径/源码。目录目标会安全失败，但 Native 文件专用读取端口的诊断码与 Node 目录导入码不同。不能据此宣称完整 npm/pnpm 兼容。

`process.versions` 报告 `holonomy` 与 `v8`，不伪造 Node 版本。宿主环境变量和身份不会自动继承。`--host-config` 已接通隔离的共享 Policy/Broker、Host System Projection 和原生 FS 的 deny-symlink profile：文件读写、二进制、open/close/FileHandle、stat/lstat、目录、rename、unlink 与 watcher/AsyncIterator。原有完整 FS JavaScript conformance 已在 macOS arm64 原生 `holo` 上通过。另有可选的 withinRoot 子集，会对解析后的目标重新准入并保留精确的原生句柄；其较窄的操作支持范围见 [Host 配置](host-configuration.zh-Hans.md)。

原生 HTTP(S) 已进入相同 Policy/Broker，支持固定 DNS 地址、TLS 验证、重定向、Abort、额度与 Host-only Mock。自包含 Cordis ESM 插件在 Host Context 中、Guest 入口之前完成初始装载，能真实拦截能力调用；包/根完整性与私有子进程启动身份均会核对。配置及限制见 [Host 配置](host-configuration.zh-Hans.md)。显式 Host profile 还可启用有界的 [macOS 原生 Process 子集](process-native-darwin.zh-Hans.md)，不依赖 Node，也不回退到任意宿主命令。

使用 `holo --watch --host-config ./holo.config.json ./index.mjs` 可校验并替换插件数组，不重启 Guest 入口。在途调用保留原插件图，失败候选保留上一版。这是配置变化监听，不是任意源码 HMR；详见 [Host 配置](host-configuration.zh-Hans.md)。

无需 Host 配置即可使用原生 Crypto：SHA-1/SHA-256、HMAC-SHA256、AES-256-GCM、同步随机字节/UUID、恒定时间比较，以及 Web `getRandomValues`/`randomUUID`。它复用共享 JS 接口，底层使用原生原语，并在执行入口前完成必需自检。详见 [Crypto 用法与限制](crypto.zh-Hans.md)；不代表完整 Node Crypto 或 Web SubtleCrypto 支持。

macOS arm64 可显式[安装 Desktop Device](device.zh-Hans.md)：form-factor、display、input、lifecycle、typed Summary 及 display/lifecycle 订阅复用共享 facade 和 Policy/Broker。真实读取、snapshot、overflow/resync 与生命周期路径已验证；物理显示/lifecycle 变化仍受证据限制，不打开 HID 设备，不读取输入报告、屏幕图像或原始标识。

Host Cordis Engine Gate 已支持受控 eval/Function、BufferSource WebAssembly 编译及真实 Runtime Response 的 `compileStreaming`/`instantiateStreaming`；缺少各自的 Policy 权限或明确批准时仍拒绝，详见 [Engine Gate](engine-gate.zh-Hans.md)。流式入口先有界读取 body 再编译，不是增量编译；启用 Host Policy 时，dynamic import 需要独立的 controlled Policy 与明确 Gate 批准。已提供显式授权的 Host-only 请求体检查和部分模块/终止 Observer 事件；限制见 [Host 配置](host-configuration.zh-Hans.md)，同步 Observer 回调尚未完成独立隔离。[原生 Storage](storage.zh-Hans.md) 可显式安装持久化 KV 和 SQLite，并已接入统一 Policy/Cordis 逐调用拦截；凭据 Provider 仍未实现；已有实验性[私有 Inspector](inspector.zh-Hans.md)及外部机器 Service 的 Native `run/test` target，实验性 Service CDP lease、入口等待/恢复和代际连接清理已接通，但不宣称完整前端兼容；Node/Android 既有支持不会自动成为原生桌面的支持声明。

可选的 `v86-backend` Cargo 构建已在独立、无 Node 的 rusty_v8 isolate 中启动通过 SHA 校验的 Linux 镜像，并从 UART 收到 `HOLO_READY` 帧。配合 Host 私有清单和 `--experimental-v86-process`，真实 Guest 用例通过了 `spawn('cat')` 的 stdin 回显/stdout/退出/close，以及 `execFile('echo')` 和受控 shell `exec('printf ...')` 的精确 callback。升级镜像拒绝所有 Guest fork/clone 和受信任 root 首次执行之后的 exec；真实同 PID 自执行拒绝用例已通过。Native Linux FUSE 已通过双向读写和按进程归因的拒绝；[受限网络桥接](process-v86-network.zh-Hans.md) 已通过真实 Linux TCP/UDP、Host DNS、curl HTTP 和直接/重定向拒绝，使用同一 Kernel/Broker。它保持 Experimental，不代表完整 TLS、地址族或网络工具兼容。受限 FUSE 用例已覆盖 ACCESS、文件/目录 fsync、元数据与 chmod，以及 Git init/status；深层进程树、完整 POSIX/Git 兼容和更广的 Process/FS 接受度仍待验证；默认可执行文件不包含也不启用 v86。

[Linux 一次性 Device/System 读取](process-v86-capabilities.zh-Hans.md)需要单独启用，保留逐进程来源、类型化 Host 投影、精度/隐私上限及插件拒绝，不授予 Linux 事件订阅。Native v86 网络生命周期测试还覆盖预先/运行中 AbortError 投递、并发 VM 清理、socket 配额恢复与新 Runtime 隔离，均为有限范围的 Experimental 证据。

每次运行独占一个由同一二进制启动的子进程。显式退出码透传，未处理 rejection 导致失败，`--timeout` 可中断同步循环和微任务死循环；启动控制管道关闭时，孤立 Runtime 会取消。

macOS 上，SIGINT（Ctrl-C）、SIGTERM 和 SIGHUP 会取消本次运行，分别返回退出码 130、143 和 129。CLI 留出一秒清理时间，随后强制停止自己创建的私有 Runtime 进程组；第二次信号会立即请求强制停止。这是 CLI 退出行为，不代表支持 JavaScript `process.on('SIGINT')` 回调。

启用 Host 配置后，插件和 Provider 在该 Runtime 进程内独立的 V8 isolate/native 线程中运行。用户 JS 忙碌时，Host 定时器和异步工作仍可推进；运行期限和所有者断开会取消两侧 isolate。同一 Host 插件图也拥有异步的受控字符串代码生成决定。

构建后执行 `pnpm package:native --output ./target/my-native-artifact` 可生成本地开发包；输出目录必须尚不存在。命令核对 Runtime、Host control、plugin-validator、module-planner 四个内嵌资源摘要，解压产物，再以空 `PATH` 实际执行交付的二进制。目录内包含压缩包、`manifest.json`、`verification.json` 和 `SHA256SUMS`；解压后运行 `bin/holo ./index.js`。`--binary FILE` 可以指定其他已构建的二进制，但资源过期或版本不一致会被拒绝。

`verification.json` 最后原子发布；缺少它就表示本次打包未完成。发布前还会用解压后的二进制执行精确摘要的 Wasm 函数并得到 42，验证 Wasm/动态 import 的允许和拒绝，包括缓存命中被拒绝且不重复产生副作用。失败时仅清理私有暂存，输出目录和可能已有的部分文件会保留；重试请使用新的目录。这些同机窄 smoke 不等于全新机器兼容或完整 M4 验收。

二进制使用锁定 `v8` crate 提供的标准 snapshot 和 ICU。开发包清单记录依赖锁文件摘要及二进制/内嵌 JS 的精确摘要，不是可复现构建证明。目前不能作为正式发布包：签名、公证、安装/更新管理与完整第三方分发声明/SBOM 仍未完成，包内 LICENSE 仅覆盖 Holonomy 自身。
