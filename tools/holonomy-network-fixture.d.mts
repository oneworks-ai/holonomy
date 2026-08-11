export interface HolonomyNetworkFixtureContext {
  readonly env: Record<string, string>
  readonly networkFixturePort: number | undefined
}

export const requiresHolonomyNetworkFixture: (
  command: string,
  entries: readonly string[]
) => boolean

export const startHolonomyNetworkFixture: () => Promise<{
  readonly close: () => Promise<void>
  readonly port: number
  readonly url: string
}>

export const runWithHolonomyNetworkFixture: <T>(
  input: {
    readonly command: string
    readonly entries: readonly string[]
    readonly env: Record<string, string>
  },
  callback: (fixture: HolonomyNetworkFixtureContext) => T | Promise<T>
) => Promise<T>
