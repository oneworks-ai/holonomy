import type { SystemInformationFieldV1 } from '@holonomyjs/runtime/kernel/registry-types'

export type NodeArchV1 =
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

export type NodePlatformV1 =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'unknown'

export type NodeTypeV1 =
  | 'AIX'
  | 'Android'
  | 'Darwin'
  | 'FreeBSD'
  | 'Linux'
  | 'OpenBSD'
  | 'SunOS'
  | 'Windows_NT'
  | 'unknown'

export interface NodeCpuInfoV1 {
  readonly model: string
  readonly speed: number
  readonly times: Readonly<{ idle: number; irq: number; nice: number; sys: number; user: number }>
}

export interface NodeNetworkInterfaceInfoV1 {
  readonly address: string
  readonly cidr: string | null
  readonly family: 'IPv4' | 'IPv6'
  readonly internal: boolean
  readonly mac: string
  readonly netmask: string
  readonly scopeid?: number
}

export interface NodeUserInfoV1 {
  readonly gid: number
  readonly homedir: string
  readonly shell: string | null
  readonly uid: number
  readonly username: string
}

export interface SystemFieldValueMapV1 {
  readonly 'os.arch': NodeArchV1
  readonly 'os.availableParallelism': number
  readonly 'os.cpus': readonly NodeCpuInfoV1[]
  readonly 'os.freemem': number
  readonly 'os.homedir': string
  readonly 'os.hostname': string
  readonly 'os.loadavg': readonly [number, number, number]
  readonly 'os.machine': string
  readonly 'os.networkInterfaces': Readonly<Record<string, readonly NodeNetworkInterfaceInfoV1[]>>
  readonly 'os.platform': NodePlatformV1
  readonly 'os.release': string
  readonly 'os.tmpdir': string
  readonly 'os.totalmem': number
  readonly 'os.type': NodeTypeV1
  readonly 'os.uptime': number
  readonly 'os.userInfo': NodeUserInfoV1
  readonly 'os.version': string
  readonly 'process.cwd': string
  readonly 'process.env': Readonly<Record<string, string>>
  readonly 'process.execPath': string
  readonly 'process.pid': number
}

export type SystemProjectionModeV1 = 'real' | 'redacted' | 'synthetic' | 'unavailable'
export type SystemProjectionPrecisionV1 = 'coarse' | 'exact' | 'none' | 'redacted'

export type HostSystemFieldProjectionV1<K extends SystemInformationFieldV1> =
  | Readonly<{
    mode: 'real' | 'synthetic'
    precision: 'coarse' | 'exact'
    value: SystemFieldValueMapV1[K]
  }>
  | Readonly<{
    mode: 'redacted'
    precision: 'redacted'
    value: SystemFieldValueMapV1[K]
  }>
  | Readonly<{ mode: 'unavailable'; precision: 'none' }>

export interface HostSystemProjectionV1 {
  readonly fields: Readonly<
    {
      [K in SystemInformationFieldV1]?: HostSystemFieldProjectionV1<K>
    }
  >
  readonly schemaVersion: 1
}
