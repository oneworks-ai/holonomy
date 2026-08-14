import type { CapabilityGuestBridgeV1 } from './guest-facade-support.js'
import { createCapabilitySyntheticBindingV1 } from './guest-facade-support.js'
import { CapabilityFsFacadeCallsV1 } from './guest-fs-calls.js'
import { createCapabilityFsNodeModuleV1 } from './guest-fs-node-module.js'
import { createCapabilityFsPromisesModuleV1 } from './guest-fs-promises-module.js'

export const createCapabilityFsModuleOverridesV1 = (bridge: CapabilityGuestBridgeV1) => {
  const calls = new CapabilityFsFacadeCallsV1(bridge)
  const fsDefault = createCapabilityFsNodeModuleV1(bridge, calls)
  const fsPromisesDefault = createCapabilityFsPromisesModuleV1(bridge, calls)
  return Object.freeze({
    'node:fs': createCapabilitySyntheticBindingV1(
      { ...fsDefault, default: fsDefault },
      [...Object.keys(fsDefault), 'default']
    ),
    'node:fs/promises': createCapabilitySyntheticBindingV1(
      { ...fsPromisesDefault, default: fsPromisesDefault },
      [...Object.keys(fsPromisesDefault), 'default']
    )
  })
}
