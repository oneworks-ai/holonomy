import { pathToFileURL as nodePathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createUrlSyntheticModule } from '../../src/node-compat/url.js'

const url = createUrlSyntheticModule({ virtualRoot: '/app' })

describe('node:url virtual file boundary', () => {
  it('uses Web URL classes and matches Node path encoding within the virtual root', () => {
    const path = '/app/plugin/a file#name%.mjs'
    expect(url.pathToFileURL(path).href).toBe(nodePathToFileURL(path).href)
    expect(url.fileURLToPath(url.pathToFileURL(path))).toBe(path)
    expect(new url.URL('child', 'app://runtime/root/').href).toBe(
      'app://runtime/root/child'
    )
    expect(new url.URLSearchParams('a=1&a=2').getAll('a')).toEqual(['1', '2'])
    for (const pathWithBoundary of ['/app/plugin/', '/app/a\n\r\t/']) {
      expect(url.pathToFileURL(pathWithBoundary).href).toBe(
        nodePathToFileURL(pathWithBoundary).href
      )
      expect(url.fileURLToPath(url.pathToFileURL(pathWithBoundary))).toBe(
        pathWithBoundary
      )
    }
  })

  it('exposes documented canonicalization and percent-encoding differences', () => {
    const repeatedSeparators = '/app/plugin//nested///file.mjs'
    const canonicalUrl = url.pathToFileURL(repeatedSeparators)
    expect(url.fileURLToPath(canonicalUrl)).toBe('/app/plugin/nested/file.mjs')
    expect(url.fileURLToPath(canonicalUrl)).not.toBe(repeatedSeparators)

    for (const path of ['/app/[plugin]', '/app/a|b', '/app/a^b']) {
      expect(url.pathToFileURL(path).href, path).not.toBe(
        nodePathToFileURL(path).href
      )
    }
  })

  it('maps only the configured app origin into virtualRoot', () => {
    expect(url.fileURLToPath('app://runtime/plugins/example.mjs')).toBe(
      '/app/plugins/example.mjs'
    )
    const custom = createUrlSyntheticModule({
      appBaseUrl: 'app://oneworks/',
      virtualRoot: '/app'
    })
    expect(custom.fileURLToPath('app://oneworks/cache/a')).toBe('/app/cache/a')
    expect(() => custom.fileURLToPath('app://runtime/cache/a')).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_INVALID_URL' })
    )
  })

  it('rejects root escapes, remote files and encoded separators', () => {
    for (
      const input of [
        'file:///etc/passwd',
        'file://remote/app/file',
        'https://runtime/app/file',
        'file:///app/a%2Fb'
      ]
    ) {
      expect(() => url.fileURLToPath(input), input).toThrow()
    }
    expect(() => url.pathToFileURL('/app/../../etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'ERR_HOLONOMY_OUT_OF_BOUNDS' })
    )
  })

  it('accepts injected Web constructors', () => {
    const injected = createUrlSyntheticModule({
      virtualRoot: '/app',
      webStandards: { URL, URLSearchParams }
    })
    expect(injected.URL).toBe(URL)
    expect(injected.URLSearchParams).toBe(URLSearchParams)
  })

  it('rejects ambiguous app bases with query, fragment or an empty host', () => {
    for (
      const appBaseUrl of [
        'app://runtime/?query=1',
        'app://runtime/?',
        'app://runtime/#fragment',
        'app://runtime/#',
        'app:///'
      ]
    ) {
      expect(() => createUrlSyntheticModule({ appBaseUrl, virtualRoot: '/app' })).toThrowError(
        expect.objectContaining({ code: 'ERR_HOLONOMY_INVALID_ARGUMENT' })
      )
    }
  })
})
