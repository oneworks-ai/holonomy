// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
} from '../../../dist/capability-runtime/index.js'

import { reserveNodeProcessDescendantV1 } from './capability-process-descendant-reservation.mjs'
import { ProcessCallbackEventChannelV1, ProcessEventChannelV1 } from './capability-process-events.mjs'
import { processResourcePublicationsV1 } from './capability-process-publications.mjs'
import {
  bindNodeProcessChildEventsV1,
  bindNodeProcessReadableV1,
  bindNodeProcessStdinV1
} from './capability-process-resource-events.mjs'
import { invokeNodeProcessResourceV1 } from './capability-process-resource-operations.mjs'
import { nodeError } from './capability-process-support.mjs'

export class NodeProcessResourceManagerV1 {
  #active = new Map()
  #backend
  #nextId = 1
  #linuxTrees = new Map()
  #openPipes = 0
  #policy
  #total = 0

  constructor(policy, backend) {
    this.#backend = backend
    this.#policy = policy
  }

  allocatePublicId() {
    return this.#nextId++
  }

  reserveSync(operation, stdio, authorityProcessLimit) {
    this.#reserve(operation, stdio, false, authorityProcessLimit)
  }

  close() {
    for (const state of this.#active.values()) this.#closeState(state, 'SIGKILL')
  }

  invoke(context, authority, resource) {
    const state = this.#active.get(resource.processResourceId)
    if (state == null) throw new CapabilityInvocationError('resource.stale', context.operation)
    return invokeNodeProcessResourceV1({
      authority,
      backend: this.#backend,
      close: (target, signal) => this.#closeState(target, signal),
      context,
      policy: this.#policy,
      state
    })
  }

  reserveDescendant(context) {
    const source = context.source
    const active = this.#active.get(source.processResourceId)
    if (active == null) {
      throw new CapabilityInvocationError('resource.stale', context.operation)
    }
    const result = reserveNodeProcessDescendantV1({
      active,
      context,
      policy: this.#policy,
      total: this.#total,
      tree: this.#linuxTrees.get(source.processResourceId)
    })
    this.#linuxTrees.set(source.processResourceId, result.identities)
    this.#total += result.totalIncrement
  }

  spawn(context, authority, requested, executableId, launch, env, stdio, options, authorityProcessLimit) {
    const pipeCount = this.#reserve(context.operation, stdio, true, authorityProcessLimit)
    const resourceId = `process-${this.allocatePublicId()}`
    let execution
    try {
      execution = this.#backend.spawn(launch, {
        cwd: launch.cwd,
        detached: true,
        env,
        shell: false,
        stdio
      }, { processResourceId: resourceId })
    } catch (error) {
      this.#openPipes -= pipeCount
      throw error
    }
    const child = execution.child
    const resource = canonicalizeProcessInstanceResource({
      executableSemanticResourceDigest: requested.semanticResourceDigest,
      generation: context.runtime.generation,
      label: resourceId,
      processResourceId: resourceId
    })
    const childEvents = new ProcessEventChannelV1(256 * 1024)
    const stdinEvents = new ProcessCallbackEventChannelV1()
    const captureLimit = options.maxBufferBytes ?? Number.MAX_SAFE_INTEGER
    const stdoutEvents = new ProcessEventChannelV1(Math.min(captureLimit, this.#policy.limits.maxStdoutBytes))
    const stderrEvents = new ProcessEventChannelV1(Math.min(captureLimit, this.#policy.limits.maxStderrBytes))
    const binding = type => ({
      binding: { bindingId: `${resourceId}-${type}`, generation: context.runtime.generation },
      resourceType: type
    })
    const facade = {
      ...binding('process.child'),
      pid: this.allocatePublicId(),
      stderr: stdio[2] === 'pipe' ? binding('process.readable') : null,
      stdin: stdio[0] === 'pipe' ? binding('process.stdin') : null,
      stdout: stdio[1] === 'pipe' ? binding('process.readable') : null
    }
    if (facade.stdout != null) facade.stdout.binding.bindingId += '-stdout'
    if (facade.stderr != null) facade.stderr.binding.bindingId += '-stderr'
    const state = {
      child,
      childEvents,
      executableId,
      facade,
      killTree: execution.killTree,
      outputFailed: false,
      pipeCount,
      pendingStdinCallbacks: new Set(),
      resource,
      resourceId,
      stderrEvents,
      stdinBytes: 0,
      stdinClosed: false,
      stdinEnded: false,
      stdinError: undefined,
      stdinEvents,
      stdoutEvents,
      timer: undefined
    }
    this.#active.set(resourceId, state)
    bindNodeProcessChildEventsV1(state, () => {
      this.#active.delete(resourceId)
      this.#linuxTrees.delete(resourceId)
      this.#openPipes -= state.pipeCount
      clearTimeout(state.timer)
    })
    bindNodeProcessStdinV1(child.stdin, state)
    bindNodeProcessReadableV1(child.stdout, stdoutEvents, state, () => this.#closeState(state, 'SIGKILL'))
    bindNodeProcessReadableV1(child.stderr, stderrEvents, state, () => this.#closeState(state, 'SIGKILL'))
    const timeout = Math.min(
      options.timeoutMs ?? this.#policy.limits.maxExecutionTimeMs,
      this.#policy.limits.maxExecutionTimeMs
    )
    state.timer = setTimeout(() => {
      childEvents.emit({ event: 'error', tuple: [nodeError('ETIMEDOUT')] })
      this.#closeState(state, 'SIGKILL')
    }, timeout)
    return authority.complete(
      trustedInvocationValueFromJsonV1(facade, 'result'),
      processResourcePublicationsV1(state, () => this.#closeState(state, 'SIGKILL'))
    )
  }

  #closeState(state, signal) {
    if (!this.#active.has(state.resourceId)) return
    state.killTree(signal)
  }

  #reserve(operation, stdio, keepOpen, authorityProcessLimit) {
    if (
      !Array.isArray(stdio) || stdio.length !== 3 ||
      stdio.some(value => value !== 'ignore' && value !== 'pipe')
    ) throw new CapabilityInvocationError('argument.invalid', operation)
    const pipeCount = stdio.filter(value => value === 'pipe').length
    if (
      this.#active.size >= Math.min(this.#policy.limits.maxConcurrentProcesses, authorityProcessLimit) ||
      this.#total >= this.#policy.limits.maxTotalProcesses ||
      this.#openPipes + pipeCount > this.#policy.limits.maxOpenPipes
    ) throw new CapabilityInvocationError('resource.handle_limit', operation)
    this.#total += 1
    if (keepOpen) this.#openPipes += pipeCount
    return pipeCount
  }
}
