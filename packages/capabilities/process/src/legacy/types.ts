import type { GitFacade } from '@holonomyjs/runtime/git/types'

export interface ChildProcessLimits {
  maxArgBytes: number
  maxArgCount: number
  maxStderrBytes: number
  maxStdoutBytes: number
}

export interface ExecFileOptions {
  encoding?: 'utf8' | 'utf-8'
  maxBuffer?: number
  signal?: AbortSignal
  timeout?: number
}

export type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

export interface ChildProcessSyntheticModule {
  readonly default: Readonly<Omit<ChildProcessSyntheticModule, 'default'>>
  readonly execFile: (
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: ExecFileCallback
  ) => void
}

export interface ChildProcessSyntheticModuleBinding {
  readonly descriptor: Readonly<{ readonly exportNames: readonly string[] }>
  readonly namespace: ChildProcessSyntheticModule
}

export interface ChildProcessFactoryOptions {
  readonly git: GitFacade
  readonly limits?: Partial<ChildProcessLimits>
}
