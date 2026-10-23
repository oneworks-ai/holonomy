import type { CapabilitySelectionV1 } from './capability-types.js'
import type { AdmittedRuntimeCreationV1 } from './context-types.js'

export interface CapabilityRuntimeInvocationKernelOptionsV1 {
  readonly admitted: AdmittedRuntimeCreationV1
  readonly engine: string
  readonly networkProvider: 'host.network' | 'host.network.mock'
  readonly networkRequestBodyReader?: CapabilitySelectionV1
  readonly requestPrefix: string
  readonly target: 'android' | 'desktop' | 'node'
}
