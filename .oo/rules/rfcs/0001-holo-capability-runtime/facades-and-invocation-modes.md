# RFC-0001：Module Facade 与调用模式

[返回 RFC 总览](../0001-holo-capability-runtime.md)

## 12. Module Facade、Proxy 与跨 Realm

### 12.1 Module Loader 是入口安全边界

Guest 的静态 import、动态 import 和 Synthetic Module 必须统一由 Holonomy Module Loader 解析。Guest 不得取得 ambient `require`、系统 `createRequire` 或 Host 默认 Loader。

### 12.2 Proxy 只用于投影

Proxy 可以生成 namespace、嵌套 namespace 和资源 facade，但不得把原生对象作为 target：

```ts
const guestFacade = new Proxy(Object.create(null), handler)
```

禁止：

```ts
const unsafeNativeProxy = new Proxy(nativeFs, handler)
void unsafeNativeProxy
```

命名导出需要独立 callable wrapper，因为 `import { readFile }` 不会经过 default namespace 的 `get` trap。

### 12.3 资源对象

原生 FileHandle、Socket、Stream、设备对象和 Host exception 不得进入 Guest。返回值必须是 Guest Realm facade，背后使用 Bridge 颁发的不透明资源句柄，并绑定：

```text
principal + processId + generation + policyDigest + operation rights + canonical resource
```

### 12.4 反射边界

Facade 必须覆盖并测试：

- `Object.getPrototypeOf` 和 `constructor.constructor`；
- `Reflect.get`、property descriptors 和 symbols；
- `then`/thenable 误识别；
- getter/setter、Proxy、循环引用和 exotic prototypes；
- 跨 Realm `Uint8Array`、Error、AbortSignal 和回调；
- 保存旧函数引用后 restart/dispose 的 fencing。

## 13. 同步、Callback 与 Promise

### 13.1 Node API

Node 已定义入口时保持 Node 形态：

```ts
import { readFile, readFileSync } from 'node:fs'
import { readFile as readFilePromise } from 'node:fs/promises'
```

三者共享 `filesystem.file.read` operation 和相同 Middleware。

Callback 必须重新调度回 Guest Event Loop；Provider/Host 线程不得直接调用 Guest callback。

Broker 终态先形成 `InternalCapabilityError`，再由 facade 翻译。`node:*` 必须保持 Node 兼容：同步入口抛错、callback 使用 error-first 且 exactly-once、Promise 入口 reject；`code` 使用 `EACCES`、`ENOENT`、`EINVAL`、`EMFILE`、`AbortError` 或对应 `ERR_*`。虚拟路径可以进入 Node error 的 `path`，原生路径不得进入。`holo:*` 才公开 `HoloError` 与 `holo.*` 稳定码。完整映射见[附录 E](network-and-node-errors.md)。

### 13.2 Holo API

Node 没有标准的能力可以提供同步和 Promise 双入口：

```ts
import { getWifiState } from 'holo:device'
import { getWifiState as getWifiStateAsync } from 'holo:device/promises'
```

订阅、扫描、用户选择和长生命周期资源只放 Promise 入口。

### 13.3 同步 Middleware

同步 Guest API 遇到异步 Host Middleware 时，支持该能力的平台必须：

1. 只阻塞独立 Guest Runtime thread/子进程；
2. 由独立 Host 线程或 IPC 接收决定；
3. 不阻塞 Android UI、Electron main/renderer 或响应所依赖的 Node event loop；
4. 支持 deadline、cancel、stop/restart 唤醒和 fail-closed；
5. 检测 Middleware 递归进入同一 Runtime 导致的死锁。

平台没有 blocking bridge 时返回稳定 `holo.async_required`，不得伪同步。

同一 operation 的 sync/callback/promise 共享同一个内部 terminal、resource identity 和 retryability；三个 facade 只翻译交付形态，不重新执行 Policy、Middleware 或 Provider。
