// Built runtime contract: adapter production code must use the package payload, not TypeScript sources.
import {
  CapabilityInvocationError,
  canonicalizeProcessInstanceResource,
  trustedInvocationValueFromJsonV1
} from '../../../dist/capability-runtime/index.js'

import { ProcessCallbackEventChannelV1, ProcessEventChannelV1 } from './capability-process-events.mjs'
import { closeProcessStdinV1, processResourcePublicationsV1 } from './capability-process-publications.mjs'
import { invokeNodeProcessResourceV1 } from './capability-process-resource-operations.mjs'
import { binary, nodeError } from './capability-process-support.mjs'

export class NodeProcessResourceManagerV1 {
  #active = new Map()
  #backend
  #nextId = 1
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
    this.#bindChildEvents(state)
    this.#bindStdin(child.stdin, state)
    this.#bindReadable(child.stdout, stdoutEvents, state)
    this.#bindReadable(child.stderr, stderrEvents, state)
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

  #bindChildEvents(state) {
    const { child, childEvents, resourceId } = state
    child.once('spawn', () => childEvents.emit({ event: 'spawn', tuple: [] }))
    child.once('error', () => {
      childEvents.emit({ event: 'error', tuple: [nodeError('ERR_OPERATION_FAILED')] })
    })
    child.once('exit', (code, signal) => childEvents.emit({ event: 'exit', tuple: [code, signal] }))
    child.once('close', (code, signal) => {
      childEvents.emit({ event: 'close', tuple: [code, signal] })
      this.#active.delete(resourceId)
      this.#openPipes -= state.pipeCount
      clearTimeout(state.timer)
    })
  }

  #bindReadable(stream, events, state) {
    if (stream == null) return
    stream.on('data', chunk => {
      if (!events.emit({ event: 'data', tuple: [binary(chunk)] }, chunk.byteLength) && !state.outputFailed) {
        state.outputFailed = true
        const error = nodeError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        events.fail(error)
        state.childEvents.emit({ event: 'error', tuple: [error] })
        this.#closeState(state, 'SIGKILL')
      }
    })
    stream.once('end', () => events.emit({ event: 'end', tuple: [] }))
    stream.once('error', () => events.emit({ event: 'error', tuple: [nodeError('EIO')] }))
    stream.once('close', () => events.emit({ event: 'close', tuple: [] }))
  }

  #bindStdin(stream, state) {
    if (stream == null) return
    stream.on('error', error => {
      state.stdinError = nodeError(error?.code === 'ERR_INVALID_STATE' ? 'ERR_INVALID_STATE' : 'EIO')
    })
    stream.once('close', () => closeProcessStdinV1(state))
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
