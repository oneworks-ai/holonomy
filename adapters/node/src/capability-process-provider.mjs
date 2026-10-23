import { ProcessProviderV1 } from '@holonomyjs/capability-process/host/provider'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
} from '../../../dist/capability-runtime/index.js'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from './capability-process-backend.mjs'
import { NodeProcessHostPortV1 } from './capability-process-host-port.mjs'

const contracts = Object.freeze({
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
})

export class NodeProcessProviderV1 extends ProcessProviderV1 {
  constructor(profile, policy, generation, registry = NODE_PROCESS_BACKEND_REGISTRY_V1, options = {}) {
    const backend = registry.get(profile.backend.backendId)
    if (backend == null) throw new TypeError('Node Process Backend is unavailable')
    super(profile, policy, generation, new NodeProcessHostPortV1(backend, options.networkResolution), contracts)
  }
}
