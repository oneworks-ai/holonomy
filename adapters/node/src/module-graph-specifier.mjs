export const pluginIdentity = (url, bundleSha256) => {
  const identity = new URL(url)
  identity.searchParams.set('holo-bundle', bundleSha256)
  return identity.href
}

export const resolveRuntimeModuleSpecifier = (specifier, parentUrl) => {
  if (specifier.startsWith('node:')) return specifier
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(specifier)) {
    try {
      const url = new URL(specifier)
      if (url.href !== specifier || url.hash !== '') throw new TypeError('Non-canonical URL')
      return url.href
    } catch {
      throw new TypeError('Invalid Node Runtime module specifier')
    }
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    throw new TypeError('Bare module specifiers are unavailable in Node Runtime')
  }
  try {
    return new URL(specifier, parentUrl).href
  } catch {
    throw new TypeError('Invalid Node Runtime module specifier')
  }
}
