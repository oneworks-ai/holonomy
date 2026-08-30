import type { CapabilityProviderResourcePublicationV1, CapabilityRuntimeIdentityV1 } from './broker-types.js'
import { canonicalDigest } from './canonical-json.js'
import { canonicalizeOpaqueHandleResource } from './canonical-resources.js'
import type { CapabilitySelectionV1 } from './capability-types.js'
import { CapabilityInvocationError, capabilityFailure } from './errors.js'
import { validateFiniteJsonSchemaV1 } from './finite-schema-validator.js'
import { operationSchemaOwnerV1 } from './registry-schema-ids.js'
import type { CanonicalResourceV1 } from './resource-types.js'
import { identifier } from './validation.js'

export interface CapabilityResourceRecordV1 {
  readonly identity: CapabilityRuntimeIdentityV1
  readonly publication: CapabilityProviderResourcePublicationV1
  readonly providerModule: string
  readonly resource: CanonicalResourceV1
  readonly selection: CapabilitySelectionV1
  references: number
}

const facade = (value: unknown) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const binding = candidate.binding
  if (binding == null || typeof binding !== 'object' || Array.isArray(binding)) return undefined
  const fields = binding as Record<string, unknown>
  if (typeof fields.bindingId !== 'string' || typeof fields.generation !== 'number') return undefined
  if (typeof candidate.resourceType !== 'string') return undefined
  return {
    bindingId: identifier(fields.bindingId),
    generation: fields.generation,
    resourceType: identifier(candidate.resourceType)
  }
}

export class CapabilityResourceRegistryV1 {
  readonly #identity: CapabilityRuntimeIdentityV1
  readonly #records = new Map<string, CapabilityResourceRecordV1>()

  constructor(identity: CapabilityRuntimeIdentityV1) {
    this.#identity = identity
  }

  close(reason: 'cancelled' | 'generation-stale'): void {
    const records = [...this.#records.values()]
    this.#records.clear()
    for (const record of records) void Promise.resolve(record.publication.close?.(reason)).catch(() => undefined)
  }

  get(bindingIdValue: unknown, resourceTypeValue?: unknown): CapabilityResourceRecordV1 {
    const bindingId = identifier(bindingIdValue)
    const record = this.#records.get(bindingId) ?? capabilityFailure(
      'runtime.generation_stale',
      'runtime.resource',
      bindingId
    )
    if (record.identity.generation !== this.#identity.generation) {
      capabilityFailure('runtime.generation_stale', 'runtime.resource', bindingId)
    }
    if (resourceTypeValue != null && identifier(resourceTypeValue) !== record.publication.resourceType) {
      capabilityFailure('resource.invalid', 'runtime.resource', bindingId)
    }
    return record
  }

  publish(
    value: unknown,
    publications: readonly CapabilityProviderResourcePublicationV1[] | undefined,
    providerModule: string,
    selection: CapabilitySelectionV1,
    inheritedBindingId?: string
  ): void {
    const resultFacade = facade(value)
    if (resultFacade != null && resultFacade.generation !== this.#identity.generation) {
      capabilityFailure('provider.protocol_error', 'runtime.resource', resultFacade.bindingId)
    }
    if (
      resultFacade != null &&
      !publications?.some(item =>
        item.bindingId === resultFacade.bindingId && item.resourceType === resultFacade.resourceType
      )
    ) {
      const current = this.#records.get(resultFacade.bindingId) ?? capabilityFailure(
        'provider.protocol_error',
        'runtime.resource',
        resultFacade.bindingId
      )
      if (
        current.publication.resourceType !== resultFacade.resourceType ||
        current.identity.generation !== resultFacade.generation
      ) {
        capabilityFailure('provider.protocol_error', 'runtime.resource', resultFacade.bindingId)
      }
      if (resultFacade.bindingId !== inheritedBindingId) current.references += 1
    }
    if (publications == null) return
    const authorityDigest = canonicalDigest(selection.authorityBindings.map(item => item.authorityDigest).sort())
    for (const publication of publications) {
      const bindingId = identifier(publication.bindingId)
      const resourceType = identifier(publication.resourceType)
      if (this.#records.has(bindingId)) {
        capabilityFailure('provider.protocol_error', 'runtime.resource', bindingId)
      }
      const resource = publication.resource ?? canonicalizeOpaqueHandleResource({
        bridgeIdentityDigest: canonicalDigest([
          'capabilityResource',
          this.#identity.processId,
          this.#identity.generation,
          bindingId,
          resourceType
        ]),
        generation: this.#identity.generation,
        label: resourceType,
        resourceType,
        rightsDigest: authorityDigest
      })
      if (publication.subscribe != null) {
        const owner = publication.eventSchemaId == null ? undefined : operationSchemaOwnerV1(publication.eventSchemaId)
        if (owner == null || !owner.roles.includes('event')) {
          capabilityFailure('provider.protocol_error', 'runtime.resource', bindingId)
        }
      }
      this.#records.set(bindingId, {
        identity: this.#identity,
        publication: Object.freeze(publication),
        providerModule,
        references: 1,
        resource,
        selection
      })
    }
  }

  release(bindingIdValue: unknown, reason: 'cancelled' | 'closed' | 'generation-stale' = 'closed'): void {
    const record = this.get(bindingIdValue)
    record.references -= 1
    if (record.references > 0) return
    this.#records.delete(record.publication.bindingId)
    void Promise.resolve(record.publication.close?.(reason)).catch(() => undefined)
  }

  subscribe(bindingIdValue: unknown, listener: (event: unknown) => void): () => void {
    const record = this.get(bindingIdValue)
    if (record.publication.subscribe == null) {
      throw new CapabilityInvocationError('provider.unavailable', 'runtime.resource.subscribe')
    }
    let active = true
    let dispose: () => void = () => undefined
    dispose = record.publication.subscribe(event => {
      if (!active || event.envelope.direction !== 'result') return
      const owner = operationSchemaOwnerV1(record.publication.eventSchemaId!)!
      if (!validateFiniteJsonSchemaV1(owner.schema, event.value)) {
        active = false
        dispose()
        return
      }
      listener(event.value)
    })
    return () => {
      if (!active) return
      active = false
      dispose()
    }
  }
}
