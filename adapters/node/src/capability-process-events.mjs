import {
  ProcessCallbackEventChannelV1 as SharedCallbackChannel,
  ProcessEventChannelV1 as SharedEventChannel
} from '@holonomyjs/capability-process/host/events'
import { trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

// Compatibility exports for the adapter's existing focused tests.
export class ProcessCallbackEventChannelV1 extends SharedCallbackChannel {
  constructor() {
    super(trustedInvocationValueFromJsonV1)
  }
}

export class ProcessEventChannelV1 extends SharedEventChannel {
  constructor(maximum) {
    super(maximum, trustedInvocationValueFromJsonV1)
  }
}
