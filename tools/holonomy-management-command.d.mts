import type { HolonomyCommandIo } from './holonomy-managed-command.mjs'

export function parseAndRunHolonomyManagementCommand(
  input: readonly string[],
  io: HolonomyCommandIo,
  dependencies?: Readonly<Record<string, unknown>>
): Promise<number | undefined>
