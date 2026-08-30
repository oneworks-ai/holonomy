export type HolonomyTestPlatform = 'android' | 'desktop' | 'ios' | 'node' | 'web'
export type TestCallback = (context: Readonly<{ name: string }>) => unknown | PromiseLike<unknown>
export type HookCallback = () => unknown | PromiseLike<unknown>

export interface TestFailure {
  readonly message: string
  readonly name: string
  readonly stack?: string
}

export interface TestCaseResult {
  readonly durationMs: number
  readonly failure?: TestFailure
  readonly name: string
  readonly path: readonly string[]
  readonly platform?: HolonomyTestPlatform
  readonly status: 'failed' | 'passed' | 'skipped'
}

export interface TestRunSummary {
  readonly common: Readonly<{ failed: number; passed: number; total: number }>
  readonly durationMs: number
  readonly failed: number
  readonly passed: number
  readonly platform: HolonomyTestPlatform
  readonly platformVerification: Readonly<{ failed: number; passed: number; skipped: number; total: number }>
  readonly results: readonly TestCaseResult[]
  readonly skipped: number
  readonly total: number
}

export interface HolonomyPlatformRegistration<Callback> {
  android(name: string, callback: Callback): void
  desktop(name: string, callback: Callback): void
  ios(name: string, callback: Callback): void
  node(name: string, callback: Callback): void
  web(name: string, callback: Callback): void
}

export interface TestRegistration {
  (name: string, callback: TestCallback): void
  readonly holonomy: HolonomyPlatformRegistration<TestCallback>
  skip(name: string, callback?: TestCallback): void
}

export interface DescribeRegistration {
  (name: string, callback: () => void): void
  readonly holonomy: HolonomyPlatformRegistration<() => void>
  skip(name: string, callback?: () => void): void
}
