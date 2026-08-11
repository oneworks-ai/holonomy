import { serviceError } from './errors.mjs'
import { requireIdentifier, requireInteger } from './validation.mjs'

export const matchPath = (pathname, expression) => {
  const match = expression.exec(pathname)
  if (match == null) return undefined
  try {
    return match.slice(1).map(value => requireIdentifier(decodeURIComponent(value)))
  } catch {
    throw serviceError('service.invalid_request', 'Resource path is invalid')
  }
}

export const numberQuery = (url, name, fallback, options) => {
  const raw = url.searchParams.get(name)
  return raw == null ? fallback : requireInteger(Number(raw), name, options)
}
