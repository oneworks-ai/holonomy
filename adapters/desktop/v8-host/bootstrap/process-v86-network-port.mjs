/* eslint-disable max-lines -- Exact Process DNS evidence and receipt pairing live in one Host port. */
import { LinuxProcessNetworkCapabilityBridgeV1 } from '../../../../packages/capabilities/network/src/kernel/linux-process-network-bridge.ts'
import { authorizeResolvedAddress } from '../../../../packages/capabilities/network/src/web/authority.ts'
import {
  CapabilityInvocationError,
  normalizeResolutionEvidenceV1,
  resolutionEvidenceDigestV1
} from '../../../../packages/runtime/src/kernel/index.ts'

const fail = code => {
  throw new CapabilityInvocationError(code, 'process.network.connect')
}
const sha = value => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value)
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])

/** Host-only Process authorization and exact-address I/O, separate from Fetch. */
export class NativeV86ProcessNetworkPortV1 {
  #native
  #generation
  #policy
  #authorize = new LinuxProcessNetworkCapabilityBridgeV1()
  #prepared = new Map()
  #authorizationQueue = []
  #authorizationBusy = false
  #activeAuthorization
  #now
  #closed = false

  constructor(native, generation, policy, now) {
    if (
      native == null || typeof native.processNetworkSync !== 'function' ||
      typeof native.processNetworkStart !== 'function' || typeof native.processNetworkCancel !== 'function' ||
      typeof now !== 'function' || !Number.isSafeInteger(generation) || generation < 1
    ) throw new TypeError('Native v86 Process network port unavailable')
    this.#native = native
    this.#generation = generation
    this.#policy = policy
    this.#now = now
    this.#sync({ kind: 'installProfile', policy })
  }

  bind(invoke) {
    this.#authorize.bind(invoke)
  }

  #prunePrepared() {
    const now = this.#now()
    for (const [digest, prepared] of this.#prepared) {
      if (now <= prepared.expiresAtMonotonicMs) continue
      this.#prepared.delete(digest)
      try {
        this.#sync({ kind: 'discardResolution', resolutionToken: prepared.token })
      } catch {}
    }
  }

  #sync(input) {
    if (this.#closed) return fail('resource.stale')
    const result = JSON.parse(this.#native.processNetworkSync(JSON.stringify({
      schemaVersion: 1,
      generation: this.#generation,
      ...input
    })))
    if (result?.ok !== true) return fail(result?.code ?? 'provider.unavailable')
    return result.value
  }

  #cleanupLate(value) {
    const cleanup = (kind, key, token) => {
      if (typeof token !== 'string') return
      try {
        this.#native.processNetworkSync(JSON.stringify({
          schemaVersion: 1,
          generation: this.#generation,
          kind,
          [key]: token
        }))
      } catch {}
    }
    cleanup('close', 'socketToken', value?.socketToken)
    cleanup('discardResolution', 'resolutionToken', value?.resolutionToken)
  }

  #addresses(value, policy) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 64) return fail('provider.protocol_error')
    const authority = { privateNetwork: policy.network.privateNetwork === 'allow' ? 'allow' : 'deny' }
    try {
      return value.map(address => authorizeResolvedAddress(authority, address))
    } catch (error) {
      if (error?.code === 'network.invalid_url') return fail('policy.denied')
      throw error
    }
  }

  #assertActiveAdmission(context, resource) {
    const active = this.#activeAuthorization
    if (
      active == null || context?.source?.environmentId !== active.request.environmentId ||
      context.source.linuxPid !== active.source.linuxPid ||
      context.source.processResourceId !== active.source.processResourceId ||
      context.source.syntheticProcessId !== active.source.processId ||
      resource?.hostname !== active.endpoint.hostname || resource.port !== active.endpoint.port ||
      resource.transport !== active.endpoint.transport
    ) return fail('provider.protocol_error')
    if (this.#closed || active.request.signal.aborted || context.signal.aborted) return fail('runtime.cancelled')
    if (this.#now() >= active.deadlineMs) return fail('provider.timeout')
    return active
  }

  async task(kind, fields, signal, ceiling = 30_000) {
    const creates = ['openTcp', 'openUdp', 'httpRequest'].includes(kind)
    let succeeded = false
    let started
    let abort
    try {
      if (this.#closed || signal?.aborted) return fail('runtime.cancelled')
      const deadlineMs = this.#now() + Math.min(30_000, ceiling)
      started = this.#native.processNetworkStart(JSON.stringify({
        schemaVersion: 1,
        kind,
        generation: this.#generation,
        deadlineMs,
        ...fields
      }))
      if (started?.promise == null) return fail('provider.protocol_error')
      const completion = Promise.resolve(started.promise)
      if (!Number.isSafeInteger(started.id) || started.id < 0) {
        try {
          await completion
        } catch (error) {
          return fail(error?.code ?? 'provider.unavailable')
        }
        return fail('provider.protocol_error')
      }
      abort = () => {
        if (started.id > 0) this.#native.processNetworkCancel(started.id)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const value = JSON.parse(await completion)
      if (this.#closed || signal?.aborted) {
        this.#cleanupLate(value)
        return fail('runtime.cancelled')
      }
      if (started.id === 0) {
        this.#cleanupLate(value)
        return fail('provider.protocol_error')
      }
      succeeded = true
      return value
    } catch (error) {
      return fail(typeof error?.code === 'string' ? error.code : 'provider.unavailable')
    } finally {
      if (abort != null) signal?.removeEventListener('abort', abort)
      if (!succeeded && creates && typeof fields.resolutionToken === 'string') {
        this.#cleanupLate({ resolutionToken: fields.resolutionToken })
      }
      if (!succeeded && (this.#closed || signal?.aborted) && typeof fields.socketToken === 'string') {
        this.#cleanupLate({ socketToken: fields.socketToken })
      }
    }
  }

  async resolveNetwork({ context, generation, policy }) {
    this.#prunePrepared()
    const resource = context?.resource?.requested
    this.#assertActiveAdmission(context, resource)
    if (generation !== this.#generation || policy !== this.#policy || context?.source?.kind !== 'linuxProcess') {
      return fail('provider.protocol_error')
    }
    const resolved = await this.task('resolve', {
      environmentId: context.source.environmentId,
      hostname: resource.hostname,
      port: resource.port,
      transport: resource.transport,
      semanticResourceDigest: resource.semanticResourceDigest
    }, context.signal)
    let evidence
    try {
      this.#assertActiveAdmission(context, resource)
      if (
        typeof resolved?.resolutionToken !== 'string' || !Number.isSafeInteger(resolved.resolverGeneration) ||
        !Number.isFinite(resolved.expiresAtMonotonicMs)
      ) return fail('provider.protocol_error')
      evidence = normalizeResolutionEvidenceV1({
        kind: 'networkAddress',
        addresses: this.#addresses(resolved.addresses, policy),
        expiresAtMonotonicMs: resolved.expiresAtMonotonicMs,
        resolverGeneration: resolved.resolverGeneration
      })
    } catch (error) {
      this.#cleanupLate(resolved)
      throw error
    }
    const evidenceDigest = resolutionEvidenceDigestV1(evidence)
    const receipt = Object.freeze({
      addresses: evidence.addresses,
      evidenceDigest,
      expiresAtMonotonicMs: evidence.expiresAtMonotonicMs,
      resolverGeneration: evidence.resolverGeneration
    })
    const token = resolved.resolutionToken
    let bound = false
    const verify = async () => {
      try {
        this.#assertActiveAdmission(context, resource)
        const value = await this.task('verifyResolution', { resolutionToken: token }, context.signal)
        this.#assertActiveAdmission(context, resource)
        const addresses = this.#addresses(value.addresses, policy)
        if (
          !same(addresses, evidence.addresses) ||
          value.expiresAtMonotonicMs !== evidence.expiresAtMonotonicMs ||
          value.resolverGeneration !== evidence.resolverGeneration || value.resolutionToken !== token
        ) return fail('resource.invalid')
        return Object.freeze({ evidence, resolved: resource })
      } catch (error) {
        this.#cleanupLate({ resolutionToken: token })
        throw error
      }
    }
    const bindResolvedContext = resolvedContext => {
      this.#assertActiveAdmission(context, resource)
      const digest = resolvedContext?.resource?.binding?.invocationBindingDigest
      if (
        !sha(digest) || !sha(resource.semanticResourceDigest) || this.#prepared.has(digest) ||
        this.#prepared.size >= 128
      ) {
        return fail('provider.protocol_error')
      }
      this.#sync({
        kind: 'bindResolution',
        resolutionToken: token,
        invocationBindingDigest: digest,
        semanticResourceDigest: resource.semanticResourceDigest,
        evidenceDigest
      })
      this.#prepared.set(
        digest,
        Object.freeze({
          token,
          environmentId: context.source.environmentId,
          resource,
          evidenceDigest,
          addresses: evidence.addresses,
          expiresAtMonotonicMs: evidence.expiresAtMonotonicMs,
          resolverGeneration: evidence.resolverGeneration
        })
      )
      bound = true
    }
    const dispose = () => {
      if (bound) return
      try {
        this.#sync({ kind: 'discardResolution', resolutionToken: token })
      } catch {}
    }
    return Object.freeze({ evidence, receipt, verify, bindResolvedContext, dispose })
  }

  authorize(source, request, endpoint) {
    if (this.#closed || request.signal.aborted) {
      return Promise.reject(new CapabilityInvocationError('runtime.cancelled', 'process.network.connect'))
    }
    if (this.#authorizationQueue.length + Number(this.#authorizationBusy) >= 32) {
      return Promise.reject(new CapabilityInvocationError('provider.quota', 'process.network.connect'))
    }
    return new Promise((resolve, reject) => {
      const item = {
        source,
        request,
        endpoint,
        resolve,
        reject,
        active: false,
        done: false,
        deadlineMs: this.#now() + 30_000
      }
      const abort = code => {
        if (item.done) return
        item.done = true
        if (!item.active) {
          const index = this.#authorizationQueue.indexOf(item)
          if (index >= 0) this.#authorizationQueue.splice(index, 1)
          request.signal.removeEventListener('abort', abort)
          clearTimeout(item.timer)
        }
        reject(
          new CapabilityInvocationError(
            typeof code === 'string' ? code : 'runtime.cancelled',
            'process.network.connect'
          )
        )
      }
      item.abort = abort
      item.timer = setTimeout(() => abort('provider.timeout'), 30_000)
      request.signal.addEventListener('abort', abort, { once: true })
      this.#authorizationQueue.push(item)
      if (request.signal.aborted) abort()
      this.#runNextAuthorization()
    })
  }

  #runNextAuthorization() {
    if (this.#authorizationBusy || this.#closed) return
    const item = this.#authorizationQueue.shift()
    if (item == null) return
    if (item.done) return this.#runNextAuthorization()
    this.#authorizationBusy = true
    this.#activeAuthorization = item
    item.active = true
    void Promise.resolve().then(() => this.#authorizeOne(item.source, item.request, item.endpoint)).then(
      value => {
        if (item.done) {
          try {
            this.#sync({ kind: 'discardResolution', resolutionToken: value.resolutionToken })
          } catch {}
        } else {
          item.done = true
          item.resolve(value)
        }
      },
      error => {
        if (item.done) return
        item.done = true
        item.reject(error)
      }
    ).finally(() => {
      item.request.signal.removeEventListener('abort', item.abort)
      clearTimeout(item.timer)
      this.#activeAuthorization = undefined
      this.#authorizationBusy = false
      this.#runNextAuthorization()
    })
  }

  async #authorizeOne(source, request, endpoint) {
    this.#prunePrepared()
    if (this.#closed || request.signal.aborted) return fail('runtime.cancelled')
    if (this.#now() >= this.#activeAuthorization.deadlineMs) return fail('provider.timeout')
    const before = new Set(this.#prepared.keys())
    try {
      const receipt = await this.#authorize.authorize(Object.freeze({
        environmentId: request.environmentId,
        executableId: source.executableId,
        hostname: endpoint.hostname,
        linuxPid: source.linuxPid,
        parentLinuxPid: source.parentLinuxPid,
        policy: request.policy,
        port: endpoint.port,
        processId: source.processId,
        processResourceId: source.processResourceId,
        processStartTimeTicks: source.processStartTimeTicks,
        rootLinuxPid: source.rootLinuxPid,
        scope: request.scope,
        transport: endpoint.transport
      }))
      const prepared = this.#prepared.get(receipt.invocationBindingDigest)
      if (prepared == null) return fail('provider.protocol_error')
      this.#prepared.delete(receipt.invocationBindingDigest)
      if (
        receipt.generation !== this.#generation ||
        receipt.semanticResourceDigest !== prepared.resource.semanticResourceDigest ||
        receipt.resolution.evidenceDigest !== prepared.evidenceDigest ||
        receipt.resolution.resolverGeneration !== prepared.resolverGeneration ||
        receipt.resolution.expiresAtMonotonicMs !== prepared.expiresAtMonotonicMs ||
        !same(receipt.resolution.addresses, prepared.addresses) ||
        prepared.environmentId !== request.environmentId ||
        prepared.resource.hostname !== endpoint.hostname || prepared.resource.port !== endpoint.port ||
        prepared.resource.transport !== endpoint.transport || this.#now() > prepared.expiresAtMonotonicMs
      ) {
        this.#sync({ kind: 'discardResolution', resolutionToken: prepared.token })
        return fail('provider.protocol_error')
      }
      const address = prepared.addresses.find(value => /^\d+\.\d+\.\d+\.\d+$/u.test(value)) ??
        prepared.addresses[0]
      if (request.signal.aborted || this.#now() >= this.#activeAuthorization.deadlineMs) {
        this.#sync({ kind: 'discardResolution', resolutionToken: prepared.token })
        return fail(request.signal.aborted ? 'runtime.cancelled' : 'provider.timeout')
      }
      return Object.freeze({ receipt, resolutionToken: prepared.token, address })
    } catch (error) {
      for (const [digest, prepared] of this.#prepared) {
        if (before.has(digest)) continue
        this.#prepared.delete(digest)
        try {
          this.#sync({ kind: 'discardResolution', resolutionToken: prepared.token })
        } catch {}
      }
      throw error
    }
  }

  close(socketToken) {
    if (this.#closed) return
    try {
      this.#sync({ kind: 'close', socketToken })
    } catch {}
  }

  closeEnvironment(environmentId) {
    if (this.#closed) return
    try {
      this.#sync({ kind: 'closeEnvironment', environmentId })
    } catch {}
  }

  closeGeneration() {
    if (this.#closed) return
    const active = this.#activeAuthorization
    if (active != null && !active.done) {
      active.done = true
      active.reject(new CapabilityInvocationError('runtime.cancelled', 'process.network.connect'))
    }
    for (const item of this.#authorizationQueue.splice(0)) {
      item.done = true
      item.request.signal.removeEventListener('abort', item.abort)
      clearTimeout(item.timer)
      item.reject(new CapabilityInvocationError('runtime.cancelled', 'process.network.connect'))
    }
    for (const prepared of this.#prepared.values()) {
      try {
        this.#sync({ kind: 'discardResolution', resolutionToken: prepared.token })
      } catch {}
    }
    this.#prepared.clear()
    try {
      this.#sync({ kind: 'closeGeneration' })
    } catch {}
    this.#closed = true
  }
}
