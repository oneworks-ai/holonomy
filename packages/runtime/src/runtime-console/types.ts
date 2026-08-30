export type RuntimeConsoleLevel = 'debug' | 'error' | 'info' | 'log' | 'warn'

export interface RuntimeConsoleHostPort {
  write(level: RuntimeConsoleLevel, message: string): boolean | void
}

export interface RuntimeConsole {
  debug(...values: unknown[]): void
  error(...values: unknown[]): void
  info(...values: unknown[]): void
  log(...values: unknown[]): void
  warn(...values: unknown[]): void
}

export interface InstalledRuntimeConsole {
  readonly global: Readonly<RuntimeConsole>
  readonly syntheticModule: Readonly<RuntimeConsole & { readonly default: RuntimeConsole }>
}
