/** Platform I/O only. The shared Process Provider owns authority and resources. */
export interface ProcessRuntimeContractsV1 {
  readonly CapabilityInvocationError: new(
    code: string,
    operation: string,
    semanticResourceDigest?: string
  ) => Error
  readonly canonicalizeProcessInstanceResource: (input: unknown) => unknown
  readonly trustedInvocationValueFromJsonV1: (value: unknown, direction: 'result') => unknown
}

export interface ProcessHostSinkV1 {
  spawn(): void
  error(code: string): void
  exit(code: number | null, signal: string | null): void
  close(code: number | null, signal: string | null): void
  stdout(bytes: Uint8Array): void
  stdoutEnd(): void
  stdoutError(code: string): void
  stdoutClose(): void
  stderr(bytes: Uint8Array): void
  stderrEnd(): void
  stderrError(code: string): void
  stderrClose(): void
  stdinError(code: string): void
  stdinClose(): void
  stdinCallback(callbackId: number | undefined, code: string | null): void
}

export interface ProcessHostHandleV1 {
  writeStdin(bytes: Uint8Array, callbackId: number | undefined): boolean
  endStdin(callbackId: number | undefined): void
  destroyStdio(index: 0 | 1 | 2): void
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void
}

export interface ProcessHostPortV1<Launch = unknown> {
  readonly descriptor: {
    readonly features: {
      readonly shell: boolean
      readonly signals: boolean
      readonly synchronousSpawn: boolean
    }
  }
  byteLengthUtf8(value: string): number
  decodeInput(value: string | { readonly base64: string }): Uint8Array
  describeOutput(bytes: Uint8Array): {
    readonly base64: string
    readonly byteLength: number
    readonly sha256: string
  }
  prepareLaunch(input: {
    readonly configuration: unknown
    readonly executables: readonly unknown[]
    readonly environmentScope: string
    readonly executable: unknown
    readonly executableId: string
    readonly generation: number
    readonly operation: string
    readonly policy: unknown
    readonly runtimeArgs: readonly string[]
  }): Launch
  spawn(
    launch: Launch,
    options: {
      readonly env: Readonly<Record<string, string>>
      readonly generation: number
      readonly limits: unknown
      readonly processResourceId: string
      readonly stdio: readonly ['pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore']
    },
    sink: ProcessHostSinkV1
  ): ProcessHostHandleV1
  spawnSync?(
    launch: Launch,
    options: {
      readonly encoding: 'utf8' | 'buffer'
      readonly env: Readonly<Record<string, string>>
      readonly killSignal: 'SIGKILL'
      readonly maxBuffer: number
      readonly stdio: readonly ['pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore']
      readonly timeout: number
    }
  ): {
    readonly error?: { readonly code?: string }
    readonly signal: string | null
    readonly status: number | null
    readonly stderr: string | Uint8Array | null
    readonly stdout: string | Uint8Array | null
  }
  closeGeneration(generation: number): void | Promise<void>
  poll?(): void
  resolveNetwork?(input: unknown): Promise<unknown>
}
