export interface RuntimeProcessSnapshot {
  readonly arch: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly execPath: string
  readonly pid: number
  readonly platform: string
  readonly versions: Readonly<{ node: string }>
}

export interface RuntimeStdioProvider {
  /** Receives text or bytes directly; hosts must not add base64 transport. */
  write(
    stream: 'stderr' | 'stdout',
    chunk: string | Uint8Array
  ): boolean | void | PromiseLike<boolean | void>
}

export interface RuntimeUserInfoSnapshot {
  readonly gid: number
  readonly homedir: string
  readonly shell: null | string
  readonly uid: number
  readonly username: string
}

export interface RuntimeOsSnapshot {
  readonly arch: string
  readonly homedir: string
  readonly hostname: string
  /** Hosts must supply synthetic, non-device-identifying values. */
  readonly identityPolicy: 'synthetic'
  readonly platform: string
  readonly release: string
  readonly tmpdir: string
  readonly type: string
  readonly userInfo: RuntimeUserInfoSnapshot
}

export interface RuntimeWebStandards {
  readonly URL: typeof URL
  readonly URLSearchParams: typeof URLSearchParams
}

export interface NodeCoreCompatOptions {
  /** Root of all JS-visible file-like paths. */
  readonly virtualRoot: string
  readonly process: RuntimeProcessSnapshot
  readonly os: RuntimeOsSnapshot
  readonly stdio: RuntimeStdioProvider
  /** Maximum bytes per write; defaults to 1 MiB and may be lowered to the host limit. */
  readonly maxStdioChunkBytes?: number
  /** Defaults to app://runtime/ and is accepted by fileURLToPath. */
  readonly appBaseUrl?: string
  /** Injectable for engines that do not install Web URL globals. */
  readonly webStandards?: RuntimeWebStandards
}
