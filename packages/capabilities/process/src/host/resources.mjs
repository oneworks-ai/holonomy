import { reserveProcessDescendantV1 } from './descendant-reservation.mjs'
import { ProcessCallbackEventChannelV1, ProcessEventChannelV1 } from './events.mjs'
import { createPreReadyProcessSinkV1 } from './pre-ready-events.mjs'
import { processResourcePublicationsV1 } from './publications.mjs'
import { createProcessEventSinkV1 } from './resource-events.mjs'
import { invokeProcessResourceV1 } from './resource-operations.mjs'
import { processError } from './support.mjs'

export class ProcessResourceManagerV1 {
  #active = new Map()
  #contracts
  #nextId = 1
  #linuxTrees = new Map()
  #openPipes = 0
  #policy
  #port
  #total = 0

  constructor(policy, port, contracts) {
    this.#policy = policy
    this.#port = port
    this.#contracts = contracts
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
    if (state == null) {
      throw new this.#contracts.CapabilityInvocationError('resource.stale', context.operation)
    }
    return invokeProcessResourceV1({
      authority,
      close: (target, signal) => this.#closeState(target, signal),
      context,
      contracts: this.#contracts,
      policy: this.#policy,
      port: this.#port,
      state
    })
  }

  reserveDescendant(context) {
    const source = context.source
    const active = this.#active.get(source.processResourceId)
    if (active == null) {
      throw new this.#contracts.CapabilityInvocationError('resource.stale', context.operation)
    }
    const result = reserveProcessDescendantV1({
      active,
      context,
      policy: this.#policy,
      total: this.#total,
      tree: this.#linuxTrees.get(source.processResourceId),
      CapabilityInvocationError: this.#contracts.CapabilityInvocationError
    })
    this.#linuxTrees.set(source.processResourceId, result.identities)
    this.#total += result.totalIncrement
  }

  spawn(context, authority, requested, executableId, launch, env, stdio, options, authorityProcessLimit) {
    const pipeCount = this.#reserve(context.operation, stdio, true, authorityProcessLimit)
    const resourceId = `process-${this.allocatePublicId()}`
    const resource = this.#contracts.canonicalizeProcessInstanceResource({
      executableSemanticResourceDigest: requested.semanticResourceDigest,
      generation: context.runtime.generation,
      label: resourceId,
      processResourceId: resourceId
    })
    const trusted = this.#contracts.trustedInvocationValueFromJsonV1
    const childEvents = new ProcessEventChannelV1(256 * 1024, trusted)
    const stdinEvents = new ProcessCallbackEventChannelV1(trusted)
    const captureLimit = options.maxBufferBytes ?? Number.MAX_SAFE_INTEGER
    const stdoutEvents = new ProcessEventChannelV1(Math.min(captureLimit, this.#policy.limits.maxStdoutBytes), trusted)
    const stderrEvents = new ProcessEventChannelV1(Math.min(captureLimit, this.#policy.limits.maxStderrBytes), trusted)
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
      childEvents,
      closed: false,
      executableId,
      exited: false,
      facade,
      handle: undefined,
      outputFailed: false,
      pipeCount,
      pendingStdinCallbacks: new Set(),
      resource,
      resourceId,
      spawned: false,
      stderrEvents,
      stdinBytes: 0,
      stdinClosed: false,
      stdinEnded: false,
      stdinError: undefined,
      stdinEvents,
      stdoutEvents,
      timer: undefined
    }
    const sink = createProcessEventSinkV1(
      state,
      () => {
        this.#active.delete(resourceId)
        this.#linuxTrees.delete(resourceId)
        this.#openPipes -= state.pipeCount
        clearTimeout(state.timer)
      },
      this.#port,
      (target, signal) => this.#closeState(target, signal)
    )
    // A native port may report spawn/exit before its command returns. Admit the
    // resource first, then replay those events through the same sink in order.
    const staged = createPreReadyProcessSinkV1(sink)
    try {
      state.handle = this.#port.spawn(launch, {
        env,
        generation: context.runtime.generation,
        limits: this.#policy.limits,
        processResourceId: resourceId,
        stdio
      }, staged.portSink)
      if (
        state.handle == null || typeof state.handle.writeStdin !== 'function' ||
        typeof state.handle.endStdin !== 'function' ||
        typeof state.handle.destroyStdio !== 'function' ||
        typeof state.handle.signal !== 'function'
      ) throw new TypeError('ProcessHostPortV1 returned an invalid handle')
      if (staged.overflow()) {
        try {
          state.handle.signal('SIGKILL')
        } catch {}
        throw new this.#contracts.CapabilityInvocationError('resource.byte_limit', context.operation)
      }
    } catch (error) {
      this.#openPipes -= pipeCount
      throw error
    }
    this.#active.set(resourceId, state)
    const timeout = Math.min(
      options.timeoutMs ?? this.#policy.limits.maxExecutionTimeMs,
      this.#policy.limits.maxExecutionTimeMs
    )
    state.timer = setTimeout(() => {
      childEvents.emit({ event: 'error', tuple: [processError('ETIMEDOUT')] })
      this.#closeState(state, 'SIGKILL')
    }, timeout)
    staged.replay()
    return authority.complete(
      trusted(facade, 'result'),
      processResourcePublicationsV1(state, () => this.#closeState(state, 'SIGKILL'))
    )
  }

  #closeState(state, signal) {
    if (!this.#active.has(state.resourceId)) return
    state.handle.signal(signal)
  }

  #reserve(operation, stdio, keepOpen, authorityProcessLimit) {
    const { CapabilityInvocationError } = this.#contracts
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
