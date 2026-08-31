import type { GuestErrorFamilyV1 } from './invocation-guest-error.js'

export const guestErrorFamilyFromInvocationJsonV1 = (json: string): GuestErrorFamilyV1 => {
  try {
    const module = (JSON.parse(json) as { module?: unknown })?.module
    return module === 'node:child_process'
      ? 'childProcess'
      : module === 'node:fs' || module === 'node:fs/promises'
      ? 'nodeFs'
      : module === 'node:os' || module === 'node:process'
      ? 'nodeSystem'
      : 'holo'
  } catch {
    return 'holo'
  }
}
