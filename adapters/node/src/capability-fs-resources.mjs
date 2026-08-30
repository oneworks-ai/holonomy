import { Buffer } from 'node:buffer'
import nodeFs from 'node:fs'
import nodePath from 'node:path'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import {
  assertReadLimit,
  assertWriteLimit,
  flagRights,
  inputData,
  output,
  statSnapshot,
  watchQueueLimit
} from './capability-fs-support.mjs'

const positioned = (value, kind) => {
  if (value == null) return undefined
  if (
    typeof value !== 'object' || Array.isArray(value) || value.kind !== kind ||
    !Number.isSafeInteger(value.offset) || value.offset < 0 ||
    (kind === 'positionedRead' && (!Number.isSafeInteger(value.size) || value.size < 0)) ||
    Object.keys(value).some(key => !['kind', 'offset', 'size'].includes(key))
  ) throw new CapabilityInvocationError('argument.invalid', 'filesystem.file.read')
  return value
}

export class NodeFilesystemResourcesV1 {
  #handles = new Map()
  #nextFd = 10
  #nextWatcherId = 1
  #watchers = new Map()

  invoke(context, authority, resource, bindingId) {
    if (context.operation === 'filesystem.watch.close') {
      this.#closeWatcher(bindingId)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    const handle = this.#handles.get(bindingId)
    if (handle == null) throw new CapabilityInvocationError('resource.stale', context.operation)
    if (context.operation === 'filesystem.file.close') {
      this.#closeHandle(bindingId)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.file.read') {
      if (!handle.rights.includes('read')) {
        throw new CapabilityInvocationError('capability.denied', context.operation)
      }
      const request = positioned(context.providerData, 'positionedRead')
      const bytes = request == null
        ? nodeFs.readFileSync(handle.nativeFd)
        : (() => {
          assertReadLimit(context, request.size)
          const buffer = Buffer.alloc(request.size)
          const read = nodeFs.readSync(handle.nativeFd, buffer, 0, request.size, request.offset)
          return buffer.subarray(0, read)
        })()
      assertReadLimit(context, bytes.byteLength)
      return authority.complete(trustedInvocationValueFromJsonV1(
        output(bytes, context.arguments.options?.encoding ?? null),
        'result'
      ))
    }
    if (context.operation === 'filesystem.file.write') {
      if (!handle.rights.includes('write')) {
        throw new CapabilityInvocationError('capability.denied', context.operation)
      }
      const data = inputData(context.arguments.data)
      assertWriteLimit(context, data)
      const request = positioned(context.providerData, 'positionedWrite')
      if (request == null) {
        nodeFs.writeFileSync(handle.nativeFd, data, {
          encoding: context.arguments.options?.encoding ?? 'utf8'
        })
      } else {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, context.arguments.options?.encoding ?? 'utf8')
        const written = nodeFs.writeSync(handle.nativeFd, buffer, 0, buffer.byteLength, request.offset)
        if (written !== buffer.byteLength) {
          throw new CapabilityInvocationError('provider.unavailable', context.operation)
        }
      }
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.metadata.stat') {
      return authority.complete(trustedInvocationValueFromJsonV1(
        statSnapshot(nodeFs.fstatSync(handle.nativeFd)),
        'result'
      ))
    }
    throw new CapabilityInvocationError(
      'capability.denied',
      context.operation,
      resource.semanticResourceDigest
    )
  }

  open(context, authority, resource, target) {
    const maximum = context.authorityBindings[0]?.constraints?.limits?.maxOpenHandles
    if (typeof maximum !== 'number' || this.#handles.size >= maximum) {
      throw new CapabilityInvocationError(
        'resource.handle_limit',
        context.operation,
        resource.semanticResourceDigest
      )
    }
    const nativeFd = nodeFs.openSync(target, context.arguments.flag)
    const fd = this.#nextFd++
    const bindingId = `fd-${fd}`
    this.#handles.set(bindingId, { fd, nativeFd, rights: flagRights(context.arguments.flag) })
    const result = context.member === 'open' && context.module === 'node:fs/promises'
      ? { binding: { bindingId, generation: context.runtime.generation }, resourceType: 'filesystem.file-handle' }
      : { binding: 'opaque', fd }
    return authority.complete(trustedInvocationValueFromJsonV1(result, 'result'), [{
      bindingId,
      close: () => this.#closeHandle(bindingId),
      resource,
      resourceType: 'filesystem.file-handle'
    }])
  }

  watch(context, authority, resource, target) {
    const maximum = context.authorityBindings[0]?.constraints?.limits?.maxWatchers
    if (typeof maximum !== 'number' || maximum === 0 || this.#watchers.size >= maximum) {
      throw new CapabilityInvocationError(
        'resource.handle_limit',
        context.operation,
        resource.semanticResourceDigest
      )
    }
    const maxQueuedEvents = watchQueueLimit(context)
    const bindingId = `watch-${this.#nextWatcherId++}`
    const listeners = new Set()
    const watchedDirectoryName = nodeFs.statSync(target).isDirectory()
      ? nodePath.basename(target)
      : undefined
    const emit = value => {
      for (const listener of listeners) listener(trustedInvocationValueFromJsonV1(value, 'result'))
    }
    const watcher = nodeFs.watch(
      target,
      { persistent: context.arguments.options?.persistent !== false },
      (event, name) => {
        const filename = name == null ? null : String(name)
        if (filename === watchedDirectoryName) return
        if (filename?.startsWith('.holonomy-') === true) return
        emit({ event: 'change', tuple: [event === 'change' ? 'change' : 'rename', filename] })
      }
    )
    const state = { closed: false, emit, watcher }
    watcher.once('error', error => {
      emit({ event: 'error', tuple: [{ code: error?.code ?? 'EIO' }] })
      this.#closeWatcher(bindingId)
    })
    this.#watchers.set(bindingId, state)
    const resourceType = context.module === 'node:fs/promises'
      ? 'filesystem.watch-iterator'
      : 'filesystem.watcher'
    const facade = {
      binding: { bindingId, generation: context.runtime.generation },
      maxQueuedEvents,
      resourceType
    }
    return authority.complete(trustedInvocationValueFromJsonV1(facade, 'result'), [{
      bindingId,
      close: () => this.#closeWatcher(bindingId),
      eventSchemaId: 'VirtualFsWatcherDeliveryV1',
      resource,
      resourceType,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }])
  }

  #closeHandle(bindingId) {
    const handle = this.#handles.get(bindingId)
    if (handle == null) return
    this.#handles.delete(bindingId)
    nodeFs.closeSync(handle.nativeFd)
  }

  #closeWatcher(bindingId) {
    const state = this.#watchers.get(bindingId)
    if (state == null) return
    this.#watchers.delete(bindingId)
    state.watcher.close()
    if (!state.closed) {
      state.closed = true
      state.emit({ event: 'close', tuple: [] })
    }
  }
}
