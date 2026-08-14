export interface HolonomyCliOptions {
  allowFailures: boolean
  argv: string[]
  capabilityRuntime?: string
  config?: string
  detach: boolean
  entries: string[]
  env: Record<string, string>
  inspect?: { breakBeforeEntry: boolean; port: number }
  isolation: 'runtime' | 'isolatedProcess'
  networkRules?: string
  openapi: 'auto' | string
  openapiTokenFile?: string
  openDevTools: boolean
  pluginRoots: string[]
  reporter: 'json' | 'tap'
  rootUrl: string
  sandbox?: string
  serial?: string
  target: 'android' | 'node'
  timeoutMs: number
  timeoutExplicit: boolean
  watch: boolean
}

export function parseHolonomyArgs(input: readonly string[]): {
  command: 'run' | 'test'
  options: HolonomyCliOptions
}

export function failHolonomyCommand(message: string): never
