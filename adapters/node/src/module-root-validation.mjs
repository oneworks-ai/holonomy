import { Buffer } from 'node:buffer'

const MAX_URL_BYTES = 4 * 1024
const HIERARCHICAL_URL = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u
const MALFORMED_PERCENT_ENCODING = /%(?![0-9a-f]{2})/iu
const FORBIDDEN_PATH_ENCODING = /%(?:00|2f|5c)/iu

const invalid = () => {
  throw new TypeError('Invalid Node Runtime module root')
}

const parseGraphUrl = value => {
  if (
    typeof value !== 'string' || Buffer.byteLength(value) > MAX_URL_BYTES || !HIERARCHICAL_URL.test(value) ||
    value.includes('\0') || value.includes('\\') || MALFORMED_PERCENT_ENCODING.test(value)
  ) invalid()
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    invalid()
  }
  let decodedPath
  try {
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    invalid()
  }
  if (
    parsed.href !== value || parsed.username !== '' || parsed.password !== '' ||
    FORBIDDEN_PATH_ENCODING.test(parsed.pathname) || decodedPath.includes('\0') || decodedPath.includes('\\')
  ) invalid()
  return parsed
}

export const normalizeModuleGraphRoot = (value, moduleUrls) => {
  if (!Array.isArray(moduleUrls)) invalid()
  const root = parseGraphUrl(value)
  if (
    !root.pathname.endsWith('/') || root.search !== '' || root.hash !== '' ||
    ['holonomy:', 'node:'].includes(root.protocol)
  ) invalid()
  for (const moduleUrl of moduleUrls) {
    const parsed = parseGraphUrl(moduleUrl)
    if (
      parsed.protocol !== root.protocol || parsed.host !== root.host ||
      !parsed.pathname.startsWith(root.pathname)
    ) invalid()
  }
  return root.href
}
