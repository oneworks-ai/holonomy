export const root: string
export const androidRoot: string

export interface AndroidToolEnvironment {
  readonly [name: string]: string | undefined
}

export interface AndroidToolRunOptions {
  readonly cwd?: string
  readonly env?: AndroidToolEnvironment
  readonly inherit?: boolean
}

export function resolveAndroidSdkRoot(
  adb: string,
  environment?: AndroidToolEnvironment,
  homeDirectory?: string
): string | undefined
export function findAdb(): string
export function run(file: string, args: readonly string[], options?: AndroidToolRunOptions): string
export function selectDevice(adb: string, requested?: string): string
export function listDevices(adb: string): string[]
export function androidBuildEnvironment(
  adb: string,
  environment?: AndroidToolEnvironment,
  homeDirectory?: string
): AndroidToolEnvironment
export function listForwards(adb: string, serial: string, socket: string): number[]
export function removeForwards(adb: string, serial: string, socket: string): void
export function buildAndInstall(adb: string, serial: string, packageName: string): void
