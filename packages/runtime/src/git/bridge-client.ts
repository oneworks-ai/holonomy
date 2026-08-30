import { snapshotGitRecord } from './authority.js'
import { GIT_NATIVE_MODULE } from './constants.js'
import { createGitError, mapGitBridgeError } from './errors.js'

import type {
  NativeArgumentValue,
  NativeBridge,
  NativeCallOptions,
  NativeRequest,
  NativeResult
} from '../native-port/types.js'
import type { GitCallOptions, GitLimits, GitProgress } from './types.js'

const PROGRESS_PHASES = new Set<GitProgress['phase']>([
  'checkout',
  'compress',
  'negotiate',
  'receive',
  'resolve',
  'update',
  'write'
])
const PROGRESS_UNITS = new Set<GitProgress['unit']>(['bytes', 'objects', 'steps'])

let nextClientId = 1

const closeResources = (result: NativeResult, reason: string) => {
  for (const resource of result.resources ?? []) {
    try {
      resource.close(reason)
    } catch {}
  }
}

const parseProgress = (result: NativeResult, limits: Readonly<GitLimits>) => {
  if (result.binary?.length || result.resources?.length) {
    closeResources(result, 'malformed_git_progress')
    throw createGitError('git.protocol_error')
  }
  let progress: Record<string, unknown>
  try {
    progress = snapshotGitRecord(result.value, ['completed', 'phase', 'total', 'unit'], [
      'completed',
      'phase',
      'unit'
    ])
  } catch {
    throw createGitError('git.protocol_error')
  }
  const completed = progress.completed
  const phase = progress.phase
  const total = progress.total
  const unit = progress.unit
  const hasTotal = Object.hasOwn(progress, 'total')
  if (
    typeof phase !== 'string' || !PROGRESS_PHASES.has(phase as GitProgress['phase']) ||
    typeof unit !== 'string' || !PROGRESS_UNITS.has(unit as GitProgress['unit']) ||
    typeof completed !== 'number' || !Number.isSafeInteger(completed) || completed < 0 ||
    (hasTotal && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < completed)) ||
    (unit === 'bytes' && (
      completed > limits.maxTransferBytes ||
      (hasTotal && (total as number) > limits.maxTransferBytes)
    ))
  ) throw createGitError('git.protocol_error')
  return Object.freeze({
    completed,
    phase: phase as GitProgress['phase'],
    ...(hasTotal ? { total: total as number } : {}),
    unit: unit as GitProgress['unit']
  })
}

export class GitBridgeClient {
  readonly #clientId = nextClientId++
  #nextRequestId = 1

  constructor(
    private readonly bridge: NativeBridge,
    private readonly limits: Readonly<GitLimits>
  ) {}

  async request(
    operation: string,
    args: NativeArgumentValue,
    options: GitCallOptions = {}
  ) {
    try {
      const snapshot = this.snapshotOptions(options)
      return await this.bridge.request(this.createRequest(operation, args, snapshot), this.callOptions(snapshot))
    } catch (error) {
      throw mapGitBridgeError(error)
    }
  }

  async progressRequest(
    operation: string,
    args: NativeArgumentValue,
    options: GitCallOptions = {}
  ) {
    let stream
    let snapshot: Readonly<GitCallOptions>
    try {
      snapshot = this.snapshotOptions(options)
      stream = this.bridge.stream(this.createRequest(operation, args, snapshot), this.callOptions(snapshot))
    } catch (error) {
      throw mapGitBridgeError(error)
    }
    let progressEvents = 0
    try {
      while (true) {
        const item = await stream.next()
        if (item.done) {
          if (item.value == null) throw createGitError('git.protocol_error')
          return item.value
        }
        progressEvents += 1
        if (progressEvents > this.limits.maxProgressEvents) {
          stream.close('git_progress_limit')
          throw createGitError('git.limit_exceeded')
        }
        const progress = parseProgress(item.value, this.limits)
        snapshot.onProgress?.(progress)
      }
    } catch (error) {
      stream.close('git_progress_failed')
      throw mapGitBridgeError(error)
    }
  }

  private snapshotOptions(options: GitCallOptions): Readonly<GitCallOptions> {
    try {
      const record = Object.getPrototypeOf(options) === Object.prototype
        ? options as Record<string, unknown>
        : undefined
      if (record == null) throw new Error('invalid Git call options')
      const snapshot: Record<string, unknown> = {}
      for (const key of ['deadlineMs', 'onProgress', 'signal', 'timeoutMs']) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (descriptor == null) continue
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('invalid Git call option descriptor')
        }
        if (descriptor.value === undefined) continue
        snapshot[key] = descriptor.value
      }
      if (
        Object.hasOwn(snapshot, 'deadlineMs') &&
        (!Number.isSafeInteger(snapshot.deadlineMs) || (snapshot.deadlineMs as number) < 0)
      ) throw new Error('invalid Git deadline')
      if (
        Object.hasOwn(snapshot, 'timeoutMs') &&
        (!Number.isSafeInteger(snapshot.timeoutMs) || (snapshot.timeoutMs as number) <= 0)
      ) throw new Error('invalid Git timeout')
      if (Object.hasOwn(snapshot, 'onProgress') && typeof snapshot.onProgress !== 'function') {
        throw new Error('invalid Git progress callback')
      }
      if (Object.hasOwn(snapshot, 'signal') && (snapshot.signal == null || typeof snapshot.signal !== 'object')) {
        throw new Error('invalid Git signal')
      }
      return Object.freeze(snapshot) as Readonly<GitCallOptions>
    } catch {
      throw createGitError('git.invalid_argument')
    }
  }

  private callOptions(options: Readonly<GitCallOptions>): NativeCallOptions {
    return {
      ...(Object.hasOwn(options, 'signal') ? { signal: options.signal as AbortSignal } : {}),
      ...(Object.hasOwn(options, 'timeoutMs') ? { timeoutMs: options.timeoutMs as number } : {})
    }
  }

  private createRequest(
    operation: string,
    args: NativeArgumentValue,
    options: Readonly<GitCallOptions>
  ): NativeRequest {
    return {
      args,
      ...(Object.hasOwn(options, 'deadlineMs') ? { deadlineMs: options.deadlineMs as number } : {}),
      id: `git:${this.#clientId}:${this.#nextRequestId++}`,
      module: GIT_NATIVE_MODULE,
      operation
    }
  }
}
