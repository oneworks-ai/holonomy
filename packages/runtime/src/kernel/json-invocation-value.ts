import { trustedInvocationValueFromSnapshotV1 } from './broker-values.js'
import { canonicalDigest } from './canonical-json.js'
import { invalidPolicy } from './errors.js'
import type { InvocationSnapshotNodeV1 } from './invocation-snapshot.js'
import type { JsonValueV1 } from './json-types.js'

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

const snapshotNode = (value: JsonValueV1, depth = 0): InvocationSnapshotNodeV1 => {
  if (depth > 16) return invalidPolicy()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return Object.freeze({ kind: 'scalar', value })
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidPolicy()
    return Object.freeze({ kind: 'scalar', value: Object.is(value, -0) ? 0 : value })
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) return invalidPolicy()
    return Object.freeze({ items: Object.freeze(value.map(item => snapshotNode(item, depth + 1))), kind: 'array' })
  }
  const objectValue = value as Readonly<Record<string, JsonValueV1>>
  const keys = Object.keys(objectValue).sort(compare)
  if (keys.length > 1024) return invalidPolicy()
  return Object.freeze({
    entries: Object.freeze(keys.map(key =>
      Object.freeze({
        key,
        value: snapshotNode(objectValue[key]!, depth + 1)
      })
    )),
    kind: 'object'
  })
}

export const trustedInvocationValueFromJsonV1 = (
  value: JsonValueV1,
  direction: 'argument' | 'result'
) =>
  trustedInvocationValueFromSnapshotV1({
    direction,
    root: snapshotNode(value),
    schemaVersion: 1
  }, direction)

export const invocationJsonDigestV1 = (value: JsonValueV1): string => canonicalDigest(['invocationJson', value])
