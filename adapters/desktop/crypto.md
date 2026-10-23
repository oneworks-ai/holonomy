# Native Crypto

[简体中文](crypto.zh-Hans.md) · [Native desktop](README.md)

The native `holo` executable exposes the shared bounded Crypto profile. No `--host-config` or network/filesystem grant is needed; these are synchronous engine intrinsics, not external I/O capabilities.

```js
import { createHash, randomBytes } from 'node:crypto'

console.log(createHash('sha256').update('hello').digest('hex'))
console.log(randomBytes(16).toString('hex'))
```

Save as `index.mjs` and run `holo ./index.mjs`. `require('node:crypto')` also works in CommonJS.

| API                                            | Supported profile                                      |
| ---------------------------------------------- | ------------------------------------------------------ |
| `createHash`                                   | SHA-1, SHA-256; incremental updates                    |
| `createHmac`                                   | HMAC-SHA256                                            |
| `createCipheriv`, `createDecipheriv`           | AES-256-GCM; 32-byte key, 12-byte IV, 16-byte tag      |
| `randomBytes`, `randomUUID`, `timingSafeEqual` | Synchronous only; OS randomness/native byte comparison |
| `globalThis.crypto`, `node:crypto.webcrypto`   | `getRandomValues`, `randomUUID`; no `subtle`           |

AES-GCM updates are buffered until `final()`, including decryption: no unauthenticated plaintext is returned. Concatenate the results of `update()` and `final()` rather than relying on chunk timing. Set AAD before the first update and set the decryption tag once. Never reuse an IV with the same encryption key; IV selection is the caller's responsibility. SHA-1 is retained for compatibility, not recommended for new security-sensitive designs.

The required primitive self-test runs before user entry. A failed installation prevents execution; there is no pure-JS crypto fallback. Inputs are copied and unsupported shared, resizable, detached or proxied byte buffers are rejected. Provider/native errors are replaced with the shared fixed public errors.

Limits are 64 active contexts, 64 MiB input per context, 128 MiB aggregate context-byte accounting, 1 MiB per update/comparison, 64 KiB HMAC key/AAD and 64 KiB per random call. Accounting is not a whole-process memory limit: temporary input/output copies and engine/library storage also use memory. Hash/digest, cipher/final and Runtime disposal release context reservations.

RSA, ECDSA, PBKDF2, other ciphers, Web SubtleCrypto, crypto streams, asynchronous callbacks and native key-store integration are not part of this profile. Evidence is currently macOS arm64, not other desktop targets or new Android coverage.

Run the portable public cases with:

```sh
holo test ./conformance/capabilities/crypto-v1.test.mjs
```
