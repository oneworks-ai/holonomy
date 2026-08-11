import type { HolonomyCliOptions } from './holonomy-cli-options.mjs'

export interface HolonomyCommandIo {
  readonly stderr: { write(chunk: string): unknown }
  readonly stdout: { write(chunk: string): unknown }
}

export function runHolonomyRuntimeCommand(
  parsed: { readonly command: 'run' | 'test'; readonly options: HolonomyCliOptions },
  io: HolonomyCommandIo,
  dependencies?: Readonly<Record<string, unknown>>
): Promise<number>
