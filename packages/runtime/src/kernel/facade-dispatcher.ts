import type { CapabilityBrokerInvocationV1 } from './broker-types.js'
import type { TrustedInvocationValueV1 } from './broker-values.js'
import type { CapabilityInvocationBrokerV1 } from './broker.js'
import type { GuestErrorFamilyV1 } from './guest-errors.js'
import { translateCapabilityErrorV1 } from './guest-errors.js'

export type CapabilityCallbackV1 = (
  error: ReturnType<typeof translateCapabilityErrorV1> | null,
  result?: TrustedInvocationValueV1
) => void

export class CapabilityFacadeDispatcherV1<THostContext = unknown> {
  readonly #broker: CapabilityInvocationBrokerV1<THostContext>
  readonly #family: GuestErrorFamilyV1
  readonly #schedule: (callback: () => void) => void

  constructor(
    broker: CapabilityInvocationBrokerV1<THostContext>,
    family: GuestErrorFamilyV1,
    schedule: (callback: () => void) => void = queueMicrotask
  ) {
    this.#broker = broker
    this.#family = family
    this.#schedule = schedule
  }

  invokeSync(invocation: CapabilityBrokerInvocationV1): TrustedInvocationValueV1 {
    try {
      return this.#broker.invokeSync({ ...invocation, invocationMode: 'sync' })
    } catch (error) {
      throw translateCapabilityErrorV1(error, this.#family)
    }
  }

  async invokePromise(invocation: CapabilityBrokerInvocationV1): Promise<TrustedInvocationValueV1> {
    try {
      return await this.#broker.invoke({ ...invocation, invocationMode: 'promise' })
    } catch (error) {
      throw translateCapabilityErrorV1(error, this.#family)
    }
  }

  invokeCallback(invocation: CapabilityBrokerInvocationV1, callback: CapabilityCallbackV1): void {
    let delivered = false
    const deliver = (error: unknown, result?: TrustedInvocationValueV1) => {
      if (delivered) return
      delivered = true
      this.#schedule(() => {
        if (error == null) callback(null, result)
        else callback(translateCapabilityErrorV1(error, this.#family))
      })
    }
    void this.#broker.invoke({ ...invocation, invocationMode: 'callback' }).then(
      result => deliver(null, result),
      error => deliver(error)
    )
  }
}
