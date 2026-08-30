import type {
  ProcessBackendEnvironmentFactoryV1,
  ProcessBackendEnvironmentOpenRequestV1,
  ProcessBackendEnvironmentScopeV1,
  ProcessBackendEnvironmentV1
} from '@holonomyjs/capability-process'

export type HoloUvEnvironmentAcquireRequestV1<TConfiguration, TExecutable> = Omit<
  ProcessBackendEnvironmentOpenRequestV1<TConfiguration, TExecutable>,
  'environmentId' | 'signal'
>

export interface HoloUvEnvironmentLeaseV1<TExecutable> {
  readonly environment: Promise<ProcessBackendEnvironmentV1<TExecutable>>
  readonly environmentId: string
  readonly release: () => Promise<void>
}

interface EnvironmentRecordV1<TExecutable> {
  readonly controller: AbortController
  readonly environment: Promise<ProcessBackendEnvironmentV1<TExecutable>>
  readonly environmentId: string
  readonly generation: number
  readonly key: string
  readonly scope: ProcessBackendEnvironmentScopeV1
  closed: boolean
  closePromise?: Promise<void>
}

const invalid = (): never => {
  throw new TypeError('Invalid HoloUV environment runtime request')
}

const generation = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? value as number : invalid()

const processResourceId = (value: unknown): string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 512 && !value.includes('\0')
    ? value
    : invalid()

const scope = (value: unknown): ProcessBackendEnvironmentScopeV1 =>
  value === 'processTree' || value === 'runtime' ? value : invalid()

const environmentIdentity = (
  generationValue: number,
  scopeValue: ProcessBackendEnvironmentScopeV1,
  resourceId: string
): string =>
  scopeValue === 'runtime'
    ? `${generationValue}:runtime`
    : `${generationValue}:processTree:${resourceId}`

export class HoloUvEnvironmentRuntimeV1<TConfiguration = unknown, TExecutable = unknown> {
  readonly #closedGenerations = new Set<number>()
  readonly #factory: ProcessBackendEnvironmentFactoryV1<TConfiguration, TExecutable>
  readonly #records = new Map<string, EnvironmentRecordV1<TExecutable>>()
  #closed = false

  constructor(factory: ProcessBackendEnvironmentFactoryV1<TConfiguration, TExecutable>) {
    if (factory == null || typeof factory !== 'object' || typeof factory.open !== 'function') invalid()
    this.#factory = factory
  }

  acquire(
    request: HoloUvEnvironmentAcquireRequestV1<TConfiguration, TExecutable>,
    resourceId: string
  ): HoloUvEnvironmentLeaseV1<TExecutable> {
    if (request == null || typeof request !== 'object' || !Array.isArray(request.executables)) return invalid()
    const requestGeneration = generation(request.generation)
    const requestScope = scope(request.scope)
    const normalizedResourceId = processResourceId(resourceId)
    if (this.#closed || this.#closedGenerations.has(requestGeneration)) return invalid()
    const environmentId = environmentIdentity(requestGeneration, requestScope, normalizedResourceId)
    let record = this.#records.get(environmentId)
    if (record == null) {
      const controller = new AbortController()
      const environment = Promise.resolve().then(() =>
        this.#factory.open(Object.freeze({
          ...request,
          environmentId,
          generation: requestGeneration,
          scope: requestScope,
          signal: controller.signal
        }))
      )
      record = {
        closed: false,
        controller,
        environment,
        environmentId,
        generation: requestGeneration,
        key: environmentId,
        scope: requestScope
      }
      this.#records.set(environmentId, record)
      environment.catch(() => {
        if (this.#records.get(environmentId) === record) this.#records.delete(environmentId)
      })
    }
    const acquired = record
    return Object.freeze({
      environment: acquired.environment,
      environmentId: acquired.environmentId,
      release: () =>
        acquired.scope === 'runtime'
          ? Promise.resolve()
          : this.#closeRecord(acquired, 'process-complete')
    })
  }

  activeEnvironmentIds(): readonly string[] {
    return Object.freeze([...this.#records.keys()].sort())
  }

  async close(reason: 'cancelled' | 'generation-stale' = 'cancelled'): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const record of this.#records.values()) this.#closedGenerations.add(record.generation)
    await Promise.all([...this.#records.values()].map(record => this.#closeRecord(record, reason)))
  }

  async closeGeneration(generationValue: number): Promise<void> {
    const normalized = generation(generationValue)
    this.#closedGenerations.add(normalized)
    await Promise.all(
      [...this.#records.values()]
        .filter(record => record.generation === normalized)
        .map(record => this.#closeRecord(record, 'generation-stale'))
    )
  }

  #closeRecord(
    record: EnvironmentRecordV1<TExecutable>,
    reason: 'cancelled' | 'generation-stale' | 'process-complete'
  ): Promise<void> {
    if (record.closePromise != null) return record.closePromise
    record.closed = true
    if (this.#records.get(record.key) === record) this.#records.delete(record.key)
    record.controller.abort(reason)
    record.closePromise = record.environment.then(
      environment => Promise.resolve(environment.close(reason)).then(() => undefined, () => undefined),
      () => undefined
    )
    return record.closePromise
  }
}
