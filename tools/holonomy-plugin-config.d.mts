export interface HoloPluginConfigEntry {
  readonly config: unknown
  readonly enabled: boolean
  readonly exportName: string
  readonly id: string
  readonly integrity?: string
  readonly use: string
}

export function resolveHoloConfigPath(input?: string, options?: { cwd?: string }): string

export function parseHoloPluginJson(bytes: Uint8Array, label: string, maximumBytes?: number): unknown

export function normalizeHoloPluginConfig(
  source: unknown,
  configPath: string
): Readonly<{ configPath: string; plugins: readonly HoloPluginConfigEntry[] }>

export function readHoloPluginConfig(
  input?: string,
  options?: { cwd?: string }
): Readonly<{ configPath: string; plugins: readonly HoloPluginConfigEntry[] }>

export function validateHoloPluginOptions(schemaFile: string | undefined, value: unknown): unknown

export function validateHoloPluginOptionsValue(schema: unknown, value: unknown): unknown
