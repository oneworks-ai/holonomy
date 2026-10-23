/* eslint-disable max-lines -- One Node filesystem resource ledger owns open, I/O, watch and close. */
import { Buffer } from 'node:buffer'
import nodeFs from 'node:fs'

// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import { CapabilityInvocationError, trustedInvocationValueFromJsonV1 } from '../../../dist/capability-runtime/index.js'

import { futimens, readDirectoryFd } from './capability-fs-openat.mjs'
import { nodeFilesystemIdentityV1 } from './capability-fs-paths.mjs'
import {
  assertReadLimit,
  assertWriteLimit,
  chmodExpectedKind,
  chmodMode,
  handleFlagRights,
  inputData,
  nodeOpenFlag,
  output,
  statSnapshot,
  watchErrorSnapshot,
  watchQueueLimit
} from './capability-fs-support.mjs'
import { createFsWatchSourceV1 } from './capability-fs-watch-poll.mjs'

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
    if (context.operation === 'filesystem.metadata.chmod') {
      const mode = chmodMode(context.arguments.mode, context.operation)
      const expectedKind = chmodExpectedKind(context)
      if (expectedKind != null && handle.type !== expectedKind) {
        throw new CapabilityInvocationError('resource.invalid', context.operation)
      }
      const pinned = nodeFs.fstatSync(handle.nativeFd, { bigint: true })
      if (expectedKind != null && !(expectedKind === 'file' ? pinned.isFile() : pinned.isDirectory())) {
        throw new CapabilityInvocationError('resource.invalid', context.operation)
      }
      nodeFs.fchmodSync(handle.nativeFd, mode)
      return authority.complete(trustedInvocationValueFromJsonV1(
        context.arguments.readback === true
          ? statSnapshot(nodeFs.fstatSync(handle.nativeFd, { bigint: true }))
          : {},
        'result'
      ))
    }
    if (handle.type === 'directory') {
      if (context.operation === 'filesystem.directory.close') {
        this.#closeHandle(bindingId)
      } else if (context.operation === 'filesystem.directory.sync') {
        if (context.arguments.dataOnly === true) nodeFs.fdatasyncSync(handle.nativeFd)
        else nodeFs.fsyncSync(handle.nativeFd)
      } else {
        throw new CapabilityInvocationError('capability.denied', context.operation)
      }
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.file.close') {
      this.#closeHandle(bindingId)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.file.sync' || context.operation === 'filesystem.file.datasync') {
      if (context.operation === 'filesystem.file.sync') nodeFs.fsyncSync(handle.nativeFd)
      else nodeFs.fdatasyncSync(handle.nativeFd)
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.metadata.utimes') {
      if (!handle.rights.includes('write')) throw new CapabilityInvocationError('capability.denied', context.operation)
      futimens(handle.nativeFd, context.arguments.atime, context.arguments.mtime)
      return authority.complete(trustedInvocationValueFromJsonV1(
        context.arguments.readback === true
          ? statSnapshot(nodeFs.fstatSync(handle.nativeFd, { bigint: true }))
          : {},
        'result'
      ))
    }
    if (context.operation === 'filesystem.file.truncate') {
      if (!handle.rights.includes('write')) throw new CapabilityInvocationError('capability.denied', context.operation)
      const len = context.arguments.len
      const maximum = context.authorityBindings[0]?.constraints?.limits?.maxWriteBytes
      if (!Number.isSafeInteger(len) || len < 0 || !Number.isSafeInteger(maximum) || len > maximum) {
        throw new CapabilityInvocationError('resource.byte_limit', context.operation)
      }
      nodeFs.ftruncateSync(handle.nativeFd, len)
      return authority.complete(trustedInvocationValueFromJsonV1(
        context.arguments.readback === true
          ? statSnapshot(nodeFs.fstatSync(handle.nativeFd, { bigint: true }))
          : {},
        'result'
      ))
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
        const written = nodeFs.writeSync(
          handle.nativeFd,
          buffer,
          0,
          buffer.byteLength,
          handle.append ? null : request.offset
        )
        if (written !== buffer.byteLength) {
          throw new CapabilityInvocationError('provider.unavailable', context.operation)
        }
      }
      return authority.complete(trustedInvocationValueFromJsonV1({}, 'result'))
    }
    if (context.operation === 'filesystem.metadata.stat') {
      return authority.complete(trustedInvocationValueFromJsonV1(
        statSnapshot(nodeFs.fstatSync(handle.nativeFd, { bigint: true })),
        'result'
      ))
    }
    throw new CapabilityInvocationError(
      'capability.denied',
      context.operation,
      resource.semanticResourceDigest
    )
  }

  open(context, authority, resource, evidence, openPinned) {
    if (typeof context.arguments.flag === 'object' && context.source?.kind !== 'linuxProcess') {
      throw new CapabilityInvocationError('capability.denied', context.operation)
    }
    const maximum = context.authorityBindings[0]?.constraints?.limits?.maxOpenHandles
    if (typeof maximum !== 'number' || this.#handles.size >= maximum) {
      throw new CapabilityInvocationError(
        'resource.handle_limit',
        context.operation,
        resource.semanticResourceDigest
      )
    }
    if (
      evidence?.kind !== 'filesystemTarget' || evidence.rootId !== resource.rootId ||
      typeof evidence.targetIdentityDigest !== 'string' || typeof openPinned !== 'function'
    ) throw new CapabilityInvocationError('provider.protocol_error', context.operation)
    const requested = nodeOpenFlag(context.arguments.flag)
    const constants = nodeFs.constants
    if (evidence.targetType !== 'file' && evidence.targetType !== 'missing') {
      throw new CapabilityInvocationError('provider.unavailable', context.operation)
    }
    let nativeFd = openPinned(requested & ~constants.O_TRUNC)
    let bindingId
    try {
      const stat = nodeFs.fstatSync(nativeFd, { bigint: true })
      if (
        !stat.isFile() || evidence.targetType === 'file' &&
          nodeFilesystemIdentityV1(stat) !== evidence.targetIdentityDigest
      ) {
        throw new CapabilityInvocationError('resource.stale', context.operation, resource.semanticResourceDigest)
      }
      if (requested & constants.O_TRUNC) nodeFs.ftruncateSync(nativeFd, 0)
      const fd = this.#nextFd++
      bindingId = `fd-${fd}`
      const flag = context.arguments.flag
      this.#handles.set(bindingId, {
        append: typeof flag === 'string' ? flag.startsWith('a') : flag.append,
        fd,
        nativeFd,
        type: 'file',
        rights: handleFlagRights(flag)
      })
      const result = context.member === 'open' && context.module === 'node:fs/promises'
        ? { binding: { bindingId, generation: context.runtime.generation }, resourceType: 'filesystem.file-handle' }
        : { binding: 'opaque', fd }
      const terminal = authority.complete(trustedInvocationValueFromJsonV1(result, 'result'), [{
        bindingId,
        close: () => this.#closeHandle(bindingId),
        resource,
        resourceType: 'filesystem.file-handle'
      }])
      nativeFd = undefined
      return terminal
    } catch (error) {
      if (bindingId != null) this.#handles.delete(bindingId)
      throw error
    } finally {
      if (nativeFd != null) nodeFs.closeSync(nativeFd)
    }
  }

  openDirectory(context, authority, resource, evidence, openPinned) {
    const maximum = context.authorityBindings[0]?.constraints?.limits?.maxOpenHandles
    const entriesMaximum = context.authorityBindings[0]?.constraints?.limits?.maxDirectoryEntries
    if (
      !Number.isSafeInteger(maximum) || this.#handles.size >= maximum ||
      !Number.isSafeInteger(entriesMaximum) || entriesMaximum < 1 || entriesMaximum > 100_000
    ) {
      throw new CapabilityInvocationError('resource.handle_limit', context.operation)
    }
    let nativeFd = openPinned()
    let bindingId
    try {
      const info = nodeFs.fstatSync(nativeFd, { bigint: true })
      if (!info.isDirectory() || nodeFilesystemIdentityV1(info) !== evidence.targetIdentityDigest) {
        throw new CapabilityInvocationError('resource.stale', context.operation)
      }
      const entries = readDirectoryFd(nativeFd, entriesMaximum + 1)
        .sort((left, right) => left.name.localeCompare(right.name))
      if (entries.length > entriesMaximum) throw new CapabilityInvocationError('provider.quota', context.operation)
      bindingId = `dir-${this.#nextFd++}`
      this.#handles.set(bindingId, { nativeFd, root: resource.rootId, type: 'directory' })
      const result = {
        binding: { bindingId, generation: context.runtime.generation },
        entries,
        resourceType: 'filesystem.directory-handle'
      }
      const terminal = authority.complete(trustedInvocationValueFromJsonV1(result, 'result'), [{
        bindingId,
        close: () => this.#closeHandle(bindingId),
        resource,
        resourceType: 'filesystem.directory-handle'
      }])
      nativeFd = undefined
      return terminal
    } catch (error) {
      if (bindingId != null) this.#handles.delete(bindingId)
      throw error
    } finally {
      if (nativeFd != null) nodeFs.closeSync(nativeFd)
    }
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
    const directory = nodeFs.statSync(target).isDirectory()
    const emit = value => {
      for (const listener of listeners) listener(trustedInvocationValueFromJsonV1(value, 'result'))
    }
    const emitChange = (event, filename) => {
      if (filename?.startsWith('.holonomy-') === true) return
      emit({ event: 'change', tuple: [event, filename] })
    }
    const source = createFsWatchSourceV1(target, {
      directory,
      persistent: context.arguments.options?.persistent !== false,
      onChange: emitChange,
      onError: error => {
        emit({ event: 'error', tuple: [watchErrorSnapshot(error)] })
        this.#closeWatcher(bindingId)
      }
    })
    const state = { closed: false, emit, source }
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
    state.source.close()
    if (!state.closed) {
      state.closed = true
      state.emit({ event: 'close', tuple: [] })
    }
  }
}
