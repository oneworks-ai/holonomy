import { HOLONOMY_SERVICE_OPENAPI } from './openapi.mjs'

const methods = new Set(['delete', 'get', 'patch', 'post', 'put'])

export const createServiceSkillManifest = (openapi = HOLONOMY_SERVICE_OPENAPI) =>
  Object.freeze(
    Object.entries(openapi.paths).flatMap(([path, pathItem]) =>
      Object.entries(pathItem).flatMap(([method, operation]) => {
        if (!methods.has(method) || operation.operationId == null) return []
        return [Object.freeze({
          description: operation.summary ?? operation.responses?.[200]?.description ?? operation.operationId,
          method: method.toUpperCase(),
          name: `holonomy.service.${operation.operationId}`,
          operationId: operation.operationId,
          path,
          tags: Object.freeze([...(operation.tags ?? [])])
        })]
      })
    )
  )

export class HolonomyServiceSkillPublisher {
  #manifest

  constructor(options = {}) {
    this.#manifest = options.manifest ?? createServiceSkillManifest(options.openapi)
  }

  list() {
    return this.#manifest
  }

  async publish(port) {
    return await port.publish({ apiVersion: '1.0.0', skills: this.#manifest })
  }
}
