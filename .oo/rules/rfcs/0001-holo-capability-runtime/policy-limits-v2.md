# RFC-0001 附录 A.2：SandboxPolicy v2 Limits

[返回 Policy 与 Capability](policy-and-capabilities.md)

本表是 strict JSON Schema 的 machine constants owner。Host 可以收紧，不能放大；所有 number 是有限整数。

## A.2.1 通用边界

| Item                        | Limit                                      |
| --------------------------- | ------------------------------------------ |
| serialized policy           | 1 MiB UTF-8                                |
| nesting depth               | 16                                         |
| object keys / array entries | 1024 each                                  |
| identifier                  | 128 UTF-8 bytes, `[a-zA-Z0-9._-]+`         |
| origin                      | 2048 UTF-8 bytes, canonical HTTP(S) origin |
| virtual URL                 | 4096 UTF-8 bytes                           |
| SHA-256 digest              | exactly 64 lowercase hex                   |

Arrays marked set are deduplicated and code-point sorted before RFC8785-style canonical JSON. Unknown field、non-finite number、negative count、unsafe integer、duplicate semantic value和noncanonical origin/path拒绝，不能在digest后修正。

## A.2.2 Network

`allowedOrigins` 0–64；`allowedSchemes` 0–2。mockOnly仍以allowedOrigins/schemes限制logical request，但必须`allowPrivateNetwork=false`且永不产生real authority；restricted的每个origin scheme必须在allowedSchemes。requestBodyInspection none无其他字段；bounded `maxBytes=1..1MiB`、`maxReadsPerRuntime=1..1024`。

| Limit                    |           min |     max |
| ------------------------ | ------------: | ------: |
| maxChunkBytes            |             1 |   1 MiB |
| maxConcurrentConnections |             1 |     128 |
| maxHeaderBytes           |             1 |   1 MiB |
| maxHeaders               |             1 |    1024 |
| maxRequestBodyBytes      | maxChunkBytes |  64 MiB |
| maxResponseBodyBytes     | maxChunkBytes | 256 MiB |
| maxUrlBytes              |             1 |   1 MiB |
| maxRedirects             |             0 |      32 |
| socketTimeoutMs          |             1 |  120000 |

`maxConcurrentConnections * maxRequestBodyBytes <= 64 MiB`。mockOnly不得编译real authority；restricted缺origin即无real目标。

## A.2.3 Filesystem与Device

FS roots 1–64、每root rights 1–7；rootId 1–64 ASCII bytes且唯一；virtualUrl必须精确`holo-fs://<rootId>/`。limits：open handles 1–4096，read/write bytes 1–256MiB，directory entries 1–100000，watchers 0–1024，queued watch events 0–4096。`maxWatchers=0`或`maxQueuedEvents=0`时watch稳定拒绝；Guest `maxQueuedEvents`省略时使用Policy值，显式值只能是1–4096且不能超过Policy。相同rootId/URL重复拒绝；rights去重排序。

Device operations最多等于closed `DeviceOperationV1`数量；每项唯一。subscriptions 0–256，events/sec 1–1000，queued events 0–4096。`maxSubscriptions=0`或`maxQueuedEvents=0`时订阅稳定拒绝；Guest `maxQueuedEvents`省略时使用Policy值，显式值只能是1–4096且不能超过Policy。Privacy/precision只接受各自typed lattice；Policy operation不能声明高于Provider descriptor maxPrecision，但Provider descriptor不反向放大Policy。

## A.2.4 System、Code、Inspector、Diagnostics

System fields最多等于closed field数量；allowedModes 1–3、去重。unavailable通过缺field表达，不能出现在allowedModes。每个field的maxPrecision必须属于System lattice。

Code controlled：`maxSourceBytes=1..16MiB`、`maxOperations=1..100000`、`decisionTimeoutMs=1..120000`；none分支无额外字段。Inspector五项只有boolean，缺失补false。

Diagnostics observerEvents是closed selectable set、去重，最多全部event；`maxSourceReadBytes=0..1MiB`、`maxQueuedEvents=0..4096`、`maxObserverCallbackMs=1..120000`、`retentionMs=0..86400000`。`maxObserverCallbackMs`必须显式有限整数，v1迁移/default-deny canonical值为1；registration省略timeout时继承Policy/Host较小值，显式值也限1..120000且只能收紧，0不表示禁用。sourceReader none/metadataOnly时maxSourceReadBytes必须0；boundedSource时必须1以上并同时需要`host.diagnostics.source.read` capability。

## A.2.5 Process

executables 1–256、mounts 0–64、environment names 0–256、network endpoints 0–256；identifier/hostname/guestPath分别受通用identifier/origin同级字符串与canonical path限额。ports 1–65535且每endpoint 1–64。argumentBytes、environment value、stdin/stdout/stderr各1..16MiB；concurrent 1–64、total 1–100000、tree depth 1–32、execution time 1..86400000ms、open pipes 0–256、writable rootfs 0..4GiB、network sockets 1–256。none/shell-none/network-none分支不得携带额外字段；mount rootId必须存在于FS Policy且rights只能收紧。v1迁移默认process none。

## A.2.6 Canonical/digest vectors

共享vectors覆盖每个min/max±1、observer Policy/registration timeout 0与缺省canonical、unknown/duplicate、非canonicalorigin/virtual root/process guest path、array reorder canonical等价、跨字段乘积、deny branch附加字段、v1→v2默认deny和restart digest变化。文档示例必须通过同一个parser；不得维护只在Markdown存在的宽松Schema。
