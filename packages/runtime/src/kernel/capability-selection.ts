import { canonicalDigest } from './canonical-json.js'
import { normalizeCapabilityConstraintsV1 } from './capability-constraints.js'
import type { NormalizedCapabilityConstraintsV1 } from './capability-constraints.js'
import { meetCapabilityConstraintsV1 } from './capability-meet.js'
import { CAPABILITY_DEFINITION_BY_NAME_V1 } from './capability-registry.js'
import { capabilitySatisfiesV1 } from './capability-satisfies.js'
import type {
  AuthorityBindingV1,
  CapabilityBindingV1,
  CapabilityRefV1,
  CapabilityRequirementV1,
  CapabilitySelectionV1
} from './capability-types.js'
import { invalidPolicy } from './errors.js'
import type { BuiltInCapabilityNameV1 } from './operation-types.js'
import { array, deepFreeze, exact, identifier, integer, required, string } from './validation.js'

export interface AvailableCapabilityV1 {
  readonly constraints: NormalizedCapabilityConstraintsV1
  readonly name: BuiltInCapabilityNameV1
  readonly version: 1
}

export interface CapabilitySelectionContextV1 {
  readonly generation: number
  readonly policyDigest: string
  readonly principal: string
  readonly processId: string
}

const digest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\da-f]{64}$/u.test(value)) return invalidPolicy()
  return value
}

export const normalizeCapabilityRequirementV1 = (
  value: unknown
): CapabilityRequirementV1 => {
  const input = exact(value, ['anyOf'])
  const branches = array(required(input, 'anyOf'), 1, 64).map(branchValue => {
    const branch = exact(branchValue, ['allOf', 'branchId'])
    const refs = array(required(branch, 'allOf'), 1, 64).map(refValue => {
      const ref = exact(refValue, ['constraints', 'name', 'version'])
      const name = required(ref, 'name')
      if (typeof name !== 'string' || !CAPABILITY_DEFINITION_BY_NAME_V1.has(name as BuiltInCapabilityNameV1)) {
        return invalidPolicy()
      }
      if (required(ref, 'version') !== 1) return invalidPolicy()
      return Object.freeze({
        constraints: normalizeCapabilityConstraintsV1(
          name as BuiltInCapabilityNameV1,
          required(ref, 'constraints')
        ),
        name: name as BuiltInCapabilityNameV1,
        version: 1 as const
      })
    })
    return Object.freeze({ allOf: Object.freeze(refs), branchId: identifier(required(branch, 'branchId')) })
  })
  if (new Set(branches.map(branch => branch.branchId)).size !== branches.length) return invalidPolicy()
  return deepFreeze({ anyOf: branches })
}

const availableMap = (values: readonly AvailableCapabilityV1[]) => {
  const output = new Map<BuiltInCapabilityNameV1, NormalizedCapabilityConstraintsV1>()
  for (const value of values) {
    if (value.version !== 1 || !CAPABILITY_DEFINITION_BY_NAME_V1.has(value.name)) return invalidPolicy()
    const normalized = normalizeCapabilityConstraintsV1(value.name, value.constraints)
    const current = output.get(value.name)
    if (current === undefined) output.set(value.name, normalized)
    else {
      const merged = meetCapabilityConstraintsV1(value.name, current, normalized)
      if (merged === null) return invalidPolicy()
      output.set(value.name, merged)
    }
  }
  return output
}

const mergeRequired = (refs: readonly CapabilityRefV1[]) => {
  const output = new Map<BuiltInCapabilityNameV1, NormalizedCapabilityConstraintsV1>()
  for (const ref of refs) {
    const current = output.get(ref.name)
    if (current === undefined) output.set(ref.name, ref.constraints)
    else {
      const merged = meetCapabilityConstraintsV1(ref.name, current, ref.constraints)
      if (merged === null) return null
      output.set(ref.name, merged)
    }
  }
  return output
}

export const selectCapabilityBranchV1 = (
  requirementValue: unknown,
  availableValues: readonly AvailableCapabilityV1[],
  contextValue: CapabilitySelectionContextV1
): CapabilitySelectionV1 | null => {
  const requirement = normalizeCapabilityRequirementV1(requirementValue)
  const available = availableMap(availableValues)
  const context = {
    generation: integer(contextValue.generation, 1, Number.MAX_SAFE_INTEGER),
    policyDigest: digest(contextValue.policyDigest),
    principal: string(contextValue.principal, 256),
    processId: identifier(contextValue.processId, 128)
  }
  for (const branch of requirement.anyOf) {
    const requiredByName = mergeRequired(branch.allOf)
    if (requiredByName === null) continue
    if (
      [...requiredByName].some(([name, constraints]) => {
        const candidate = available.get(name)
        return candidate === undefined || !capabilitySatisfiesV1(name, candidate, constraints)
      })
    ) continue
    const bindings: CapabilityBindingV1[] = []
    const authorityBindings: AuthorityBindingV1[] = []
    for (const [name, constraints] of requiredByName) {
      const semanticDigest = canonicalDigest(['capability', name, 1, constraints])
      const bindingDigest = canonicalDigest([
        'capabilityBinding',
        semanticDigest,
        branch.branchId,
        context.policyDigest,
        context.processId,
        context.generation
      ])
      const definition = CAPABILITY_DEFINITION_BY_NAME_V1.get(name)!
      bindings.push(Object.freeze({
        branchId: branch.branchId,
        constraints,
        digest: bindingDigest,
        name,
        source: 'policy',
        version: 1
      }))
      authorityBindings.push(Object.freeze({
        authorityDigest: canonicalDigest([
          'authority',
          definition.providerModule,
          constraints,
          context.principal,
          context.generation,
          bindingDigest
        ]),
        authorityVersion: 1,
        capabilityName: name,
        constraints,
        providerModule: definition.providerModule
      }))
    }
    return deepFreeze({ authorityBindings, bindings, branchId: branch.branchId, requirement })
  }
  return null
}
