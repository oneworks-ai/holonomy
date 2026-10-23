# 实验性 Native v86 网络

[English](process-v86-network.md)

带 `v86-backend` feature 的 Rust `holo` 可把 Linux 程序的有界 TCP、UDP 和 HTTP 代理流量接入同一 Process 权限链。默认二进制不包含或启用 v86；macOS 原生 Darwin Process profile 继续拒绝网络，不能借这个选项取得宿主进程网络权限。

## Host 选择

先按 [Host 配置](host-configuration.zh-Hans.md)安装通过摘要校验的 agent 镜像、私有 Backend/profile 清单，并显式选择 `--experimental-v86-process`。Process Policy 的 `network` 需为 `restricted`，例如：

```json
{
  "access": "restricted",
  "endpoints": [
    { "hostname": "localhost", "ports": [8080], "transport": "tcp" }
  ],
  "maxSockets": 1,
  "privateNetwork": "allow"
}
```

这段是 `sandboxPolicy.process.network`，不是普通 JS Fetch 的 `sandboxPolicy.network`。后者可以保持 `none`。`privateNetwork: allow` 是本地 fixture 的显式授权；不要把它当作默认值。

镜像必须实际报告 `seccompUserNotification`，否则网络运行在用户程序启动前失败。Host 固定镜像、端点、配额和启用开关，Guest 不能选择其他 Backend 或绕过 Policy。当前 profile 仍拒绝 fork/clone 和 root 首次执行后的 exec，不因联网而开放后代进程。

## Linux 工具和中间件

Guest 使用既有 Node `child_process` API 启动已安装的逻辑 ID。HTTP 使用固定 v86 代理，而不是宿主 shell 或 Node fetch 回退：

```js
import { execFile } from 'node:child_process'

execFile(
  'curl',
  [
    '--noproxy',
    '',
    '--proxy',
    'http://192.168.86.1:80',
    'http://8080.external/'
  ],
  { encoding: 'utf8' },
  (error, stdout, stderr) => {
    if (error) throw error
    console.log(stdout)
  }
)
```

示例要求 Host 已在本机 8080 端口准备固定文本 fixture，并在 profile 安装 `curl`。固定代理把 `PORT.external` 转为 Host `localhost:PORT`；Host 仍需真实 DNS 证据、私网许可及端点授权。这不是 Guest 任意 DNS 或 AF_INET6 的支持声明。

TCP/UDP 新流和 HTTP 初次请求先消费 HoloUV 的真实进程归因票，再以 `process.network.connect` 进入 Kernel/Broker；Host 插件可按 `request.source` 中的 executable、Linux PID/父 PID、启动 ticks 和 process resource 判断。地址由 Host 解析、检查全部结果并固定到实际连接，Guest DNS 答案不成为权威证据。HTTP 重定向沿用最初的真实进程来源，每跳重新授权与固定地址；被拒端点不会建立连接。

代理逐跳头不转给目标，目标 Host 和长度由已准入 URL 与实际 body 重建；跨端点跳转移除 Authorization/Cookie。响应按需 pull，不把请求体、响应体或原生 token 自动写入日志/Observer。

## 直接 curl HTTPS

Linux curl 可在显式允许的 Process `tcp` endpoint 上自行完成 TLS。Host 可通过正常的只读 `/workspace` FUSE mount 仅提供**公开 CA 证书**，再执行 `curl --noproxy '*' --cacert /workspace/ca.pem https://<允许的地址>:<端口>/`。Process mount 与普通 FS 的读取权限仍需同时满足；私钥不能进入 mount。它不走 HTTP 代理，也不授予普通 JS Fetch 权限。

这里的 `tcp` 是不透明连接权限：Host 插件看到已准入的 endpoint 与进程来源，看不到加密后的 HTTP method/header，也不为 HTTPS origin/SNI 作 Host 验证。CA/主机名由 curl 检查。这**不允许**把 `tls` authority receipt 交给 raw-TCP transport；Host 管理的 HTTPS 客户端与信任根配置仍是另一条路径。

`HOLO_V86_PRODUCTION_ASSET_ROOT=/absolute/verified-agent pnpm test:native:v86-https` 执行 6 个实际 Guest JS 用例：正确 CA、错误 CA、错误主机名、Policy/插件拒绝，以及重定向到被拒的新 endpoint。两个证书失败会连接允许的 TCP/TLS 服务器，但不会发送 HTTP 请求；只有权限拒绝目标要求 TCP 连接数为零。证书、服务器均由 fixture 自有，不依赖公网。

## 当前界限

| 项目         | 界限                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| 平台/等级    | macOS arm64，显式安装，Experimental                                                                      |
| 连接数       | Process `maxSockets` 与 Host 32 个上限取交集                                                             |
| DNS          | 全地址检查、最多 64 个、30 秒内的单调过期证据                                                            |
| UDP          | 单个有效载荷最多 1472 字节；不支持分片重组                                                               |
| HTTP         | 请求 body 32 KiB、响应 body 8 MiB；每次 pull 16 KiB                                                      |
| Header / URL | 64 对 / 16 KiB；URL 2048 字节                                                                            |
| 内存/等待    | VM 与 Host/Native 队列分别有界；Host 写队列 4 MiB；操作最多 30 秒并受更早的执行期限/取消约束             |
| 未宣称       | HTTP CONNECT、通用 HTTPS 代理、Host Process HTTPS 客户端自定义信任根、Guest AF_INET6、监听/PTY、深进程树 |

直接 Guest curl TLS 已有上述有界验证，不代表任意地址族或通用 HTTPS 代理接受度。[一次性 Device/System 读取](process-v86-capabilities.zh-Hans.md)有独立的领域选择与权限；更广的 FS 和 VM snapshot/restore 仍是独立工作。此增量不提高 v86 的 Experimental 等级。

## 可重复验证

```sh
node tools/build-native-runtime.mjs
cargo build --locked -p holonomy-cli --features holonomy-desktop-v8/v86-backend
HOLO_V86_PRODUCTION_ASSET_ROOT=/absolute/verified-agent pnpm test:native:v86-network
```

这个显式门禁缺少镜像、feature 或可用 Host IPv4 fixture 会失败，不自动 skip。它搭建自有服务器，以空 PATH 执行真实 `holo test`：6 个基础网络、5 个取消/关闭/配额（含预先 abort 的 nextTick 投递）、1 个新 Runtime 隔离用例。Abort 必须在 close 前恰好投递一次 `ABORT_ERR`/`AbortError`，不只看进程被杀；另核对外部效果、被拒/配额探测/预先 abort 的端点连接数为零，并确认旧 Runtime 在真实挂起请求时退出。Node 只作测试驱动；Runtime、VM、权限与 I/O 都在 Rust/内嵌 V8 中。生产交付仍需各自的发布与平台门禁。
