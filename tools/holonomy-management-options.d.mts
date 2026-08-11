export interface HolonomyManagementOptions {
  after: number
  avd?: string
  deviceId?: string
  devtools: boolean
  drain: boolean
  expectedGeneration?: number
  follow: boolean
  listen?: string
  openapi: string
  openapiTokenFile?: string
  port?: number
  tlsCert?: string
  tlsKey?: string
  wait: boolean
}

export interface HolonomyManagementCommand {
  action: string
  command: string
  group: 'device' | 'emulator' | 'process' | 'service'
  id?: string
  options: Readonly<HolonomyManagementOptions>
}

export function parseHolonomyManagementArgs(input: readonly string[]): HolonomyManagementCommand | undefined
