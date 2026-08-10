import { invalidArgument, invalidUrl } from './errors.js'
import { joinPosix } from './path.js'
import type { RuntimeWebStandards } from './types.js'
import { assertPathWithinVirtualRoot, normalizeVirtualRoot } from './virtual-path.js'

export interface UrlCompatOptions {
  readonly appBaseUrl?: string
  readonly virtualRoot: string
  readonly webStandards?: RuntimeWebStandards
}

export interface UrlSyntheticModule {
  readonly default: Readonly<{
    URL: typeof URL
    URLSearchParams: typeof URLSearchParams
    fileURLToPath: (url: string | URL) => string
    pathToFileURL: (path: string) => URL
  }>
  readonly fileURLToPath: (url: string | URL) => string
  readonly pathToFileURL: (path: string) => URL
  readonly URL: typeof URL
  readonly URLSearchParams: typeof URLSearchParams
}

const resolveWebStandards = (
  injected?: RuntimeWebStandards
): RuntimeWebStandards => {
  if (injected) {
    return injected
  }
  if (
    typeof globalThis.URL !== 'function' ||
    typeof globalThis.URLSearchParams !== 'function'
  ) {
    invalidArgument(
      'webStandards',
      'URL and URLSearchParams must be injected by this mobile engine'
    )
  }
  return { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams }
}

const decodeUrlPathname = (pathname: string): string => {
  if (/%(?:2f|5c)/iu.test(pathname)) {
    invalidUrl('Encoded path separators are not allowed in virtual URLs')
  }
  try {
    const decoded = decodeURIComponent(pathname)
    if (decoded.includes('\0') || decoded.includes('\\')) {
      invalidUrl('Virtual URLs must not contain NUL or backslash')
    }
    return decoded
  } catch {
    return invalidUrl('Virtual URL pathname contains malformed percent encoding')
  }
}

export const createUrlSyntheticModule = (
  options: UrlCompatOptions
): UrlSyntheticModule => {
  const web = resolveWebStandards(options.webStandards)
  const virtualRoot = normalizeVirtualRoot(options.virtualRoot)
  const appBase = new web.URL(options.appBaseUrl ?? 'app://runtime/')
  const appBaseHref = appBase.href
  if (
    appBase.protocol !== 'app:' ||
    appBase.pathname !== '/' ||
    appBase.username ||
    appBase.password ||
    appBase.port ||
    !appBase.hostname ||
    appBaseHref.includes('?') ||
    appBaseHref.includes('#')
  ) {
    invalidArgument(
      'appBaseUrl',
      'appBaseUrl must be an app:// origin with a non-empty host and root pathname'
    )
  }

  const fileURLToPath = (input: string | URL): string => {
    let url: URL
    try {
      url = input instanceof web.URL ? input : new web.URL(String(input))
    } catch {
      return invalidUrl('fileURLToPath expects an absolute file: or configured app: URL')
    }
    if (url.username || url.password || url.port) {
      invalidUrl('Virtual file-like URLs must not contain credentials or ports')
    }
    const pathname = decodeUrlPathname(url.pathname)
    if (url.protocol === 'file:') {
      if (url.hostname && url.hostname !== 'localhost') {
        invalidUrl('Virtual file URLs must not contain a remote hostname')
      }
      return assertPathWithinVirtualRoot(pathname, virtualRoot, 'URL pathname')
    }
    if (url.protocol === 'app:' && url.hostname === appBase.hostname) {
      return assertPathWithinVirtualRoot(
        joinPosix(virtualRoot, pathname),
        virtualRoot,
        'app URL pathname'
      )
    }
    return invalidUrl('Only local file: and the configured app: origin are supported')
  }

  const pathToFileURL = (path: string): URL => {
    const normalized = assertPathWithinVirtualRoot(path, virtualRoot)
    const result = new web.URL('file:///')
    result.pathname = normalized
      .replaceAll('%', '%25')
      .replaceAll('\n', '%0A')
      .replaceAll('\r', '%0D')
      .replaceAll('\t', '%09')
    return result
  }

  const api = Object.freeze({
    URL: web.URL,
    URLSearchParams: web.URLSearchParams,
    fileURLToPath,
    pathToFileURL
  })
  return Object.freeze({ ...api, default: api })
}
