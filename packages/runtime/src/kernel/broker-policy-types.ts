import type { DeviceProviderDescriptorV1 } from '@holonomyjs/capability-device/kernel/device-types'
import type { HostSystemProjectionV1 } from '@holonomyjs/capability-system/kernel/system-types'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import type { CapabilitySelectionContextV1 } from './capability-selection.js'
import type { OperationDescriptorV1 } from './operation-types.js'
import type { CanonicalResourceV1 } from './resource-types.js'
import type { SandboxPolicyV2 } from './sandbox-policy.js'

export interface MaterializationInputV1 {
  readonly arguments: TrustedInvocationValueV1
  readonly context: CapabilitySelectionContextV1
  readonly descriptor: OperationDescriptorV1
  readonly deviceProviderDescriptor?: DeviceProviderDescriptorV1
  readonly policy: SandboxPolicyV2
  readonly preferredProviderModule?: string
  readonly resource: CanonicalResourceV1
  readonly systemProjection: HostSystemProjectionV1
}
