export interface AndroidNetworkFixtureReverseArguments {
  readonly add: readonly string[]
  readonly remove: readonly string[]
}

export const androidNetworkFixtureReverseArgs: (
  serial: string,
  port: number
) => AndroidNetworkFixtureReverseArguments

export const runAndroidSession: (
  request: {
    readonly payload: unknown
    readonly sessionId: string
    readonly socketName: string
  },
  options: Record<string, unknown>
) => Promise<void>
