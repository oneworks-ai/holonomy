import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { serviceError } from './errors.mjs'
import { normalizeServiceNativeObserverProfilesV1 } from './native-observer-profiles.mjs'
import { materializeNativePluginGraph } from './native-plugin-materialization.mjs'

const invalid = () => {
  throw serviceError('service.precondition_failed', 'Native Runtime Observer binding is invalid')
}

const exactData = (value, keys) => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.some(key => typeof key !== 'string')) invalid()
  actual.sort()
  if (
    actual.length !== keys.length || actual.some((key, index) => key !== keys[index]) ||
    actual.some(key => !Object.hasOwn(descriptors[key], 'value'))
  ) invalid()
  return value
}

const exactArrayData = value => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 4) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid()
  const output = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[index]
    if (descriptor == null || !Object.hasOwn(descriptor, 'value')) invalid()
    output.push(descriptor.value)
  }
  return output
}

export const validateNativeObserverProfilesForLaunchV1 = (process, prepared) => {
  const request = process.capabilityRuntime
  const idsDescriptor = request == null
    ? undefined
    : Object.getOwnPropertyDescriptor(request, 'initialObserverIds')
  const selectedDescriptor = prepared == null
    ? undefined
    : Object.getOwnPropertyDescriptor(prepared, 'observerProfiles')
  const rawIds = idsDescriptor?.value ?? []
  const rawSelected = selectedDescriptor?.value ?? []
  if (
    idsDescriptor != null && !Object.hasOwn(idsDescriptor, 'value') ||
    selectedDescriptor != null && !Object.hasOwn(selectedDescriptor, 'value') ||
    selectedDescriptor != null && selectedDescriptor.value == null ||
    !Array.isArray(rawIds) || !Array.isArray(rawSelected)
  ) invalid()
  const ids = exactArrayData(rawIds)
  const selected = exactArrayData(rawSelected)
  if (ids.length !== selected.length) invalid()
  if (ids.length === 0) {
    if (
      request != null && Object.hasOwn(request, 'nativeObserverBindingVersions') ||
      selectedDescriptor != null && selected.length !== 0
    ) invalid()
    return Object.freeze([])
  }
  const versionsDescriptor = Object.getOwnPropertyDescriptor(request, 'nativeObserverBindingVersions')
  if (versionsDescriptor == null || !Object.hasOwn(versionsDescriptor, 'value')) invalid()
  const versions = exactData(versionsDescriptor.value, [...ids])
  const cloned = new Map()
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]
    if (
      typeof id !== 'string' || id.length < 1 || id.length > 64 ||
      !/^[A-Za-z0-9][\w.-]*$/u.test(id) || index > 0 && ids[index - 1] >= id
    ) invalid()
    const row = exactData(selected[index], ['bundle', 'id', 'registration', 'sink', 'version'])
    if (row.id !== id || versions[id] !== row.version) invalid()
    cloned.set(id, {
      bundle: row.bundle,
      registration: row.registration,
      sink: row.sink,
      version: row.version
    })
  }
  let normalized
  try {
    normalized = normalizeServiceNativeObserverProfilesV1(cloned)
  } catch {
    invalid()
  }
  return Object.freeze(ids.map(id => Object.freeze({ id, ...normalized.get(id) })))
}

export const materializeNativeObserverProfilesV1 = async (
  hostRoot,
  selected,
  remainingBytes
) => {
  if (selected.length === 0) return Object.freeze({ bytes: 0, observerProfiles: Object.freeze([]) })
  const graph = await materializeNativePluginGraph(
    join(hostRoot, 'observers'),
    0,
    selected.map(profile => profile.bundle),
    remainingBytes
  )
  await mkdir(join(hostRoot, 'observer-output'), { mode: 0o700 })
  const observerProfiles = Object.freeze(selected.map((profile, index) =>
    Object.freeze({
      config: graph.plugins[index].config,
      export: graph.plugins[index].export,
      id: profile.id,
      integrity: graph.plugins[index].integrity,
      registration: profile.registration,
      sink: Object.freeze({
        maxBytes: profile.sink.maxBytes,
        path: `./observer-output/${profile.id}.jsonl`
      }),
      use: `./observers/${graph.plugins[index].use.slice(2)}`
    })
  ))
  return Object.freeze({ bytes: graph.bytes, observerProfiles })
}
