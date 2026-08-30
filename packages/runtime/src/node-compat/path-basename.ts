import { invalidArgument } from './errors.js'

export const basenamePosix = (path: string, suffix?: string): string => {
  if (typeof path !== 'string') invalidArgument('path', 'path must be a string')
  if (suffix !== undefined && typeof suffix !== 'string') {
    invalidArgument('suffix', 'suffix must be a string')
  }
  let start = 0
  let end = -1
  let matchedSlash = true
  if (suffix && suffix.length <= path.length) {
    if (suffix === path) return ''
    let suffixIndex = suffix.length - 1
    let firstNonSlashEnd = -1
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const code = path.charCodeAt(index)
      if (code === 47) {
        if (!matchedSlash) {
          start = index + 1
          break
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false
          firstNonSlashEnd = index + 1
        }
        if (suffixIndex >= 0) {
          if (code === suffix.charCodeAt(suffixIndex)) {
            suffixIndex -= 1
            if (suffixIndex === -1) end = index
          } else {
            suffixIndex = -1
            end = firstNonSlashEnd
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd
    else if (end === -1) end = path.length
    return path.slice(start, end)
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path.charCodeAt(index) === 47) {
      if (!matchedSlash) {
        start = index + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = index + 1
    }
  }
  return end === -1 ? '' : path.slice(start, end)
}
