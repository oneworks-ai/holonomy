import { realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serviceError } from './errors.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'

const SCENARIO = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const REFERENCE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?\.md$/u
const DEFAULT_SKILL_DIRECTORY = fileURLToPath(new URL('../../.oo/skills/', import.meta.url))

const resourcePath = pathname => {
  if (pathname === '/.oo/skills/index.json') return 'index.json'
  const skill = /^\/\.oo\/skills\/([^/]+)\/SKILL\.md$/u.exec(pathname)
  if (skill != null && SCENARIO.test(skill[1])) return join(skill[1], 'SKILL.md')
  const reference = /^\/\.oo\/skills\/([^/]+)\/references\/([^/]+)$/u.exec(pathname)
  if (reference != null && SCENARIO.test(reference[1]) && REFERENCE.test(reference[2])) {
    return join(reference[1], 'references', reference[2])
  }
  throw serviceError('service.not_found', 'Skill resource was not found')
}

export class ServiceSkillResources {
  #directory
  #maxBytes

  constructor(options = {}) {
    const directory = options.directory ?? DEFAULT_SKILL_DIRECTORY
    if (!isAbsolute(directory)) {
      throw serviceError('service.invalid_request', 'Skill resource directory must be absolute')
    }
    this.#directory = resolve(directory)
    this.#maxBytes = options.maxBytes ?? 1024 * 1024
  }

  async read(pathname) {
    const relative = resourcePath(pathname)
    const path = resolve(this.#directory, relative)
    if (path !== join(this.#directory, relative)) {
      throw serviceError('service.not_found', 'Skill resource was not found')
    }
    const [actualRoot, actualPath] = await Promise.all([
      realpath(this.#directory).catch(() => undefined),
      realpath(path).catch(() => undefined)
    ])
    if (actualRoot == null || actualPath !== join(actualRoot, relative)) {
      throw serviceError('service.not_found', 'Skill resource was not found')
    }
    let body
    try {
      body = await readBoundedRegularFile(path, { label: 'Skill resource', maxBytes: this.#maxBytes })
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'ENOENT') {
        throw serviceError('service.not_found', 'Skill resource was not found')
      }
      if (error?.code === 'service.state_corrupt') {
        throw serviceError('service.limit_exceeded', 'Skill resource exceeds its limit')
      }
      throw error
    }
    return {
      body,
      contentType: relative.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/markdown; charset=utf-8'
    }
  }
}
