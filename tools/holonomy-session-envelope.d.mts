export const HOLONOMY_SESSION_LIMITS: Readonly<{
  maxArgBytes: number
  maxArgs: number
  maxArgsBytes: number
  maxEnvEntries: number
  maxEnvKeyBytes: number
  maxEnvValueBytes: number
  maxEnvBytes: number
  maxModuleBytes: number
  maxModuleCount: number
  maxModulesBytes: number
  maxRequestBytes: number
  maxSocketNameBytes: number
  maxUrlBytes: number
}>

export function encodeHolonomySession(
  payload: Readonly<{
    argv?: readonly string[]
    entryUrl?: string
    env?: Readonly<Record<string, string>>
    inspector?: Readonly<{ breakBeforeEntry: boolean; socketName: string }>
    modules?: ReadonlyArray<Readonly<{ source: string; url: string }>>
    schemaVersion?: number
  }>
): string
