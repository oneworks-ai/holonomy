import { invalidArgument } from './errors.js'
import type { PathParseResult } from './path-types.js'

export const parsePosixPath = (path: string): PathParseResult => {
  if (typeof path !== 'string') {
    invalidArgument('path', 'path must be a string')
  }
  const result: PathParseResult = { base: '', dir: '', ext: '', name: '', root: '' }
  if (path.length === 0) return result
  const absolute = path.startsWith('/')
  const scanStart = absolute ? 1 : 0
  if (absolute) result.root = '/'
  let startDot = -1
  let startPart = 0
  let end = -1
  let matchedSlash = true
  let preDotState = 0

  for (let index = path.length - 1; index >= scanStart; index -= 1) {
    const code = path.charCodeAt(index)
    if (code === 47) {
      if (!matchedSlash) {
        startPart = index + 1
        break
      }
      continue
    }
    if (end === -1) {
      matchedSlash = false
      end = index + 1
    }
    if (code === 46) {
      if (startDot === -1) startDot = index
      else if (preDotState !== 1) preDotState = 1
    } else if (startDot !== -1) {
      preDotState = -1
    }
  }

  if (end !== -1) {
    const valueStart = startPart === 0 && absolute ? 1 : startPart
    const hasNoExtension = startDot === -1 ||
      preDotState === 0 ||
      (
        preDotState === 1 &&
        startDot === end - 1 &&
        startDot === startPart + 1
      )
    result.base = path.slice(valueStart, end)
    if (hasNoExtension) {
      result.name = result.base
    } else {
      result.name = path.slice(valueStart, startDot)
      result.ext = path.slice(startDot, end)
    }
  }
  if (startPart > 0) result.dir = path.slice(0, startPart - 1)
  else if (absolute) result.dir = '/'
  return result
}
