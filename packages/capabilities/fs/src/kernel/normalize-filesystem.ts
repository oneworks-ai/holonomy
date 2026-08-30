import { invalidPolicy } from '@holonomyjs/runtime/kernel/errors'
import type { FilesystemRightV2, FilesystemSandboxV2 } from '@holonomyjs/runtime/kernel/policy-types'
import {
  array,
  exact,
  identifier,
  integer,
  literal,
  required,
  string,
  stringSet
} from '@holonomyjs/runtime/kernel/validation'

const RIGHTS = [
  'create',
  'delete',
  'list',
  'move',
  'read',
  'watch',
  'write'
] as const satisfies readonly FilesystemRightV2[]

const limits = (value: unknown) => {
  const input = exact(value, [
    'maxDirectoryEntries',
    'maxOpenHandles',
    'maxQueuedEvents',
    'maxReadBytes',
    'maxWatchers',
    'maxWriteBytes'
  ])
  return Object.freeze({
    maxDirectoryEntries: integer(required(input, 'maxDirectoryEntries'), 1, 100_000),
    maxOpenHandles: integer(required(input, 'maxOpenHandles'), 1, 4096),
    maxQueuedEvents: integer(required(input, 'maxQueuedEvents'), 0, 4096),
    maxReadBytes: integer(required(input, 'maxReadBytes'), 1, 256 * 1024 * 1024),
    maxWatchers: integer(required(input, 'maxWatchers'), 0, 1024),
    maxWriteBytes: integer(required(input, 'maxWriteBytes'), 1, 256 * 1024 * 1024)
  })
}

export const canonicalVirtualPath = (value: unknown): string => {
  const input = string(value, 4096)
  if (!input.startsWith('holo-fs://') || /[\\\0?#]/u.test(input)) return invalidPolicy()
  const separator = input.indexOf('/', 'holo-fs://'.length)
  if (separator < 0) return invalidPolicy()
  const rootId = identifier(input.slice('holo-fs://'.length, separator), 64)
  const path = input.slice(separator + 1)
  const segments = path === '' ? [] : path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return invalidPolicy()
  }
  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return invalidPolicy()
    }
    if (decoded === '.' || decoded === '..' || /[/\\\0]/u.test(decoded)) return invalidPolicy()
    if (encodeURIComponent(decoded) !== segment) return invalidPolicy()
  }
  return `holo-fs://${rootId}/${segments.join('/')}`
}

export const normalizeFilesystemSandbox = (value: unknown): FilesystemSandboxV2 => {
  const input = exact(value, ['access', 'limits', 'roots'])
  const access = literal(required(input, 'access'), ['none', 'sandboxed'] as const)
  if (access === 'none') {
    if (Object.keys(input).length !== 1) return invalidPolicy()
    return Object.freeze({ access })
  }
  const rootIds = new Set<string>()
  const virtualUrls = new Set<string>()
  const roots = array(required(input, 'roots'), 1, 64).map(value => {
    const root = exact(value, ['rights', 'rootId', 'symlinks', 'virtualUrl'])
    const rootId = identifier(required(root, 'rootId'), 64)
    const virtualUrl = canonicalVirtualPath(required(root, 'virtualUrl'))
    if (virtualUrl !== `holo-fs://${rootId}/` || rootIds.has(rootId) || virtualUrls.has(virtualUrl)) {
      return invalidPolicy()
    }
    rootIds.add(rootId)
    virtualUrls.add(virtualUrl)
    return Object.freeze({
      rights: stringSet(required(root, 'rights'), RIGHTS, 1, RIGHTS.length),
      rootId,
      symlinks: literal(required(root, 'symlinks'), ['deny', 'withinRoot'] as const),
      virtualUrl: virtualUrl as `holo-fs://${string}/`
    })
  }).sort((left, right) => left.rootId.localeCompare(right.rootId))
  return Object.freeze({
    access,
    limits: limits(required(input, 'limits')),
    roots: Object.freeze(roots)
  })
}
