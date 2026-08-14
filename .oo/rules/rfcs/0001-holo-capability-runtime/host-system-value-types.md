# RFC-0001 附录 C.1：Host 系统信息值类型

[返回 Host 系统信息投影](host-system-projection.md)

```ts
type NodeArchV1 =
  | 'arm'
  | 'arm64'
  | 'ia32'
  | 'loong64'
  | 'mips'
  | 'mipsel'
  | 'ppc'
  | 'ppc64'
  | 'riscv64'
  | 's390'
  | 's390x'
  | 'x64'
  | 'unknown'
type NodePlatformV1 =
  | 'aix'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'android'
  | 'unknown'
type NodeTypeV1 =
  | 'Linux'
  | 'Darwin'
  | 'Windows_NT'
  | 'AIX'
  | 'FreeBSD'
  | 'OpenBSD'
  | 'SunOS'
  | 'Android'
  | 'unknown'

interface NodeCpuInfoV1 {
  readonly model: string
  readonly speed: number // integer MHz
  readonly times: Readonly<
    { user: number; nice: number; sys: number; idle: number; irq: number }
  >
}
interface NodeNetworkInterfaceInfoV1 {
  readonly address: string
  readonly netmask: string
  readonly family: 'IPv4' | 'IPv6'
  readonly mac: string
  readonly internal: boolean
  readonly cidr: string | null
  readonly scopeid?: number
}
interface NodeUserInfoV1 {
  readonly username: string
  readonly uid: number
  readonly gid: number
  readonly shell: string | null
  readonly homedir: string
}

interface SystemFieldValueMapV1 {
  readonly 'os.arch': NodeArchV1
  readonly 'os.machine': string
  readonly 'os.platform': NodePlatformV1
  readonly 'os.type': NodeTypeV1
  readonly 'os.release': string
  readonly 'os.version': string
  readonly 'os.cpus': readonly NodeCpuInfoV1[]
  readonly 'os.availableParallelism': number
  readonly 'os.totalmem': number
  readonly 'os.freemem': number
  readonly 'os.uptime': number
  readonly 'os.loadavg': readonly [number, number, number]
  readonly 'os.hostname': string
  readonly 'os.networkInterfaces': Readonly<
    Record<string, readonly NodeNetworkInterfaceInfoV1[]>
  >
  readonly 'os.userInfo': NodeUserInfoV1
  readonly 'os.homedir': string
  readonly 'os.tmpdir': string
  readonly 'process.pid': number
  readonly 'process.cwd': string
  readonly 'process.execPath': string
  readonly 'process.env': Readonly<Record<string, string>>
}
```

## C.1.1 范围与排序

- identifier/hostname/interface key/model/username：fatal UTF-8，最多 256 bytes；release/version：1024 bytes；虚拟 path：4096 bytes。
- CPU 最多 256 项；speed 是 0–10,000,000 的整数 MHz；times 是非负 safe integer 毫秒。
- parallelism/PID 是 1–1,048,576 的整数；memory 是非负 safe integer bytes；uptime/loadavg 是有限非负 number。
- networkInterfaces 最多 32 个排序 key、每项最多 16 个地址；address/netmask/cidr 必须 canonical IP/CIDR；MAC 为小写冒号格式；scopeid 是非负整数。
- user uid/gid 是 `-1` 或非负整数；shell 是 null 或有界虚拟/合成路径。
- env 最多 128 个、总计 64 KiB；key 匹配 `[A-Za-z_][A-Za-z0-9_]*`，value 是有界字符串；只允许 Host allowlist。
- object 使用 null prototype、unknown key 拒绝；数组按 Host snapshot 固定顺序，interface/env key 按 code point 排序。

## C.1.2 确定性 coarse/redacted

- arch/platform/type：coarse 保留枚举，redacted=`unknown`；machine/release/version：coarse 保留 family/major，redacted=`unknown`。
- cpus：coarse 将 model=`unknown`、speed 四舍五入到 100 MHz、times 清零；redacted 为空数组。parallelism coarse 向上取 2 的幂 bucket，redacted=1。
- memory coarse 向下取 2 的幂 bucket，redacted=0；uptime coarse 取整小时，loadavg coarse 取 0.5 bucket，redacted 全零。
- hostname redacted=`sandbox`；userInfo redacted=`sandbox/-1/-1/null/holo-fs://workspace/`；home/tmp/cwd/execPath 只能是 Host 提供的虚拟 path，redacted 使用固定虚拟值。
- networkInterfaces redacted 为空 object；coarse 将 key 改为排序后的 `interface-N`，地址/netmask/MAC 清零，仅保留 family/internal，不保留 cidr/scopeid。
- PID redacted=1；env redacted 为空 object。以上变换不得读取 ambient OS。
