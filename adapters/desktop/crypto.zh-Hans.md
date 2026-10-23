# 原生 Crypto

[English](crypto.md) · [原生桌面端](README.zh-Hans.md)

原生 `holo` 提供共享 Runtime 已定义的有界 Crypto 接口，无需 `--host-config` 或网络/文件权限。这些是同步引擎原语，不是外部 I/O 能力。

```js
import { createHash, randomBytes } from 'node:crypto'

console.log(createHash('sha256').update('hello').digest('hex'))
console.log(randomBytes(16).toString('hex'))
```

保存为 `index.mjs` 后运行 `holo ./index.mjs`。CommonJS 也可以使用 `require('node:crypto')`。

| API                                            | 支持范围                                          |
| ---------------------------------------------- | ------------------------------------------------- |
| `createHash`                                   | SHA-1、SHA-256；可分段 update                     |
| `createHmac`                                   | HMAC-SHA256                                       |
| `createCipheriv`、`createDecipheriv`           | AES-256-GCM；32 字节 key、12 字节 IV、16 字节 tag |
| `randomBytes`、`randomUUID`、`timingSafeEqual` | 仅同步；系统随机源/原生字节比较                   |
| `globalThis.crypto`、`node:crypto.webcrypto`   | `getRandomValues`、`randomUUID`；没有 `subtle`    |

AES-GCM 的 update 会缓存到 `final()`，解密同样如此：认证通过前不返回明文。请拼接 `update()` 与 `final()` 的结果，不依赖分块返回时机。AAD 必须在首次 update 前设置，解密 tag 只能设置一次。同一加密 key 不可重复使用 IV；IV 的选择由调用者负责。SHA-1 仅保留兼容用途，不推荐用于新的安全敏感设计。

必需加密原语的自检先于用户入口执行；安装失败会阻止执行，不回退到纯 JS 加密实现。输入会复制，拒绝共享、可变、已分离或 Proxy 包装的字节缓冲区；Provider/原生错误会转换为共享的固定公开错误。

限制为 64 个活动 context、每 context 64 MiB 输入、context 字节总计账 128 MiB、每次 update/比较 1 MiB、HMAC key/AAD 64 KiB、每次随机请求 64 KiB。计账不等于整个进程的内存上限：输入/输出临时副本和引擎/库内部存储也会占用内存。Hash 的 digest、cipher 的 final 和 Runtime dispose 会释放 context 额度。

RSA、ECDSA、PBKDF2、其他 cipher、Web SubtleCrypto、crypto stream、异步 callback 和原生密钥库不属于本支持范围。目前证据为 macOS arm64，不代表其他桌面目标或新增 Android 验证。

运行可复用的公开 JS 用例：

```sh
holo test ./conformance/capabilities/crypto-v1.test.mjs
```
