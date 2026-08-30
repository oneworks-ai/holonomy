export interface ProcessExecutablePolicyV2 {
  readonly argumentBytes: number
  readonly executableId: string
}

export type ProcessShellPolicyV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{ access: 'restricted'; executableId: string }>

export interface ProcessMountPolicyV2 {
  readonly guestPath: string
  readonly rights: readonly ('read' | 'write')[]
  readonly rootId: string
}

export interface ProcessNetworkEndpointV2 {
  readonly hostname: string
  readonly ports: readonly number[]
  readonly transport: 'tcp' | 'tls' | 'udp'
}

export type ProcessNetworkPolicyV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'restricted'
    endpoints: readonly ProcessNetworkEndpointV2[]
    maxSockets: number
  }>

export interface ProcessEnvironmentPolicyV2 {
  readonly allowedNames: readonly string[]
  readonly maxValueBytes: number
}

export interface ProcessLimitsV2 {
  readonly maxConcurrentProcesses: number
  readonly maxExecutionTimeMs: number
  readonly maxOpenPipes: number
  readonly maxProcessTreeDepth: number
  readonly maxStderrBytes: number
  readonly maxStdinBytes: number
  readonly maxStdoutBytes: number
  readonly maxTotalProcesses: number
  readonly maxWritableRootfsBytes: number
}

export type ProcessSandboxV2 =
  | Readonly<{ access: 'none' }>
  | Readonly<{
    access: 'sandboxed'
    environment: ProcessEnvironmentPolicyV2
    executables: readonly ProcessExecutablePolicyV2[]
    limits: ProcessLimitsV2
    mounts: readonly ProcessMountPolicyV2[]
    network: ProcessNetworkPolicyV2
    shell: ProcessShellPolicyV2
  }>
