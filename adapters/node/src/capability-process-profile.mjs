import { normalizeProcessProfileV1 } from '@holonomyjs/capability-process/host/profile'

import { NODE_PROCESS_BACKEND_REGISTRY_V1 } from './capability-process-backend.mjs'

export const normalizeNodeProcessProfileV1 = (
  value,
  registry = NODE_PROCESS_BACKEND_REGISTRY_V1,
  platform = 'node'
) => normalizeProcessProfileV1(value, registry, platform)
