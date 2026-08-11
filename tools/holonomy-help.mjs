import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const maxDocumentationBytes = 256 * 1024
const decodeUtf8 = new TextDecoder('utf-8', { fatal: true })

const help = `Holonomy Runtime CLI

Usage:
  holonomy run <entry.mjs> [options]
  holonomy test [patterns...] [options]
  holonomy service <start|status|stop|token rotate>
  holonomy device <list|show>
  holonomy emulator <list|start|stop|restart>
  holonomy process <list|show|stop|restart|logs|inspect|remove>
  holonomy --readme [MARKDOWN]
  holonomy --llms [MARKDOWN]

Core options:
  --target android|node     Select the required runtime host
  --device, --serial ID     Select an Android device
  --detach                  Return a managed process id without waiting
  --openapi auto|URL        Use the local service or an explicit remote service
  --openapi-token-file FILE Read a remote service token without exposing it in argv
  --sandbox FILE            Apply a per-process fail-closed sandbox policy
  --network-rules FILE      Atomically install initial declarative network rules
  --inspect[=PORT]          Enable the V8 Inspector
  --inspect-brk[=PORT]      Pause before the entry module
  --devtools                Open Holonomy DevTools
  --env KEY=VALUE           Add a guest environment value
  --arg VALUE               Add a guest argv value
  --reporter tap|json       Select the test reporter
  --timeout MS              Set the process timeout

Documentation:
  --readme [MARKDOWN]       Print the CLI guide or one selected Markdown reference
  --llms [MARKDOWN]         Alias for --readme
`

const withTrailingNewline = value => value.endsWith('\n') ? value : `${value}\n`

class HolonomyDocumentationError extends Error {}

const readMarkdown = path => {
  if (extname(path).toLowerCase() !== '.md') {
    throw new HolonomyDocumentationError('Holonomy machine documentation must be a Markdown file')
  }
  let descriptor
  try {
    const pathStatistics = lstatSync(path)
    if (pathStatistics.isSymbolicLink()) {
      throw new HolonomyDocumentationError('The requested Holonomy documentation path must not be a symbolic link')
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const statistics = fstatSync(descriptor)
    if (!statistics.isFile()) {
      throw new HolonomyDocumentationError('The requested Holonomy documentation path is not a file')
    }
    if (pathStatistics.dev !== statistics.dev || pathStatistics.ino !== statistics.ino) {
      throw new HolonomyDocumentationError('The requested Holonomy documentation file changed before it was opened')
    }
    if (statistics.size > maxDocumentationBytes) {
      throw new HolonomyDocumentationError('The requested Holonomy documentation file exceeds the size limit')
    }
    const content = new Uint8Array(maxDocumentationBytes + 1)
    let offset = 0
    while (offset < content.byteLength) {
      const bytesRead = readSync(descriptor, content, offset, content.byteLength - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxDocumentationBytes) {
      throw new HolonomyDocumentationError('The requested Holonomy documentation file exceeds the size limit')
    }
    try {
      return withTrailingNewline(decodeUtf8.decode(content.subarray(0, offset)))
    } catch {
      throw new HolonomyDocumentationError('The requested Holonomy documentation file is not valid UTF-8 Markdown')
    }
  } catch (error) {
    if (error instanceof HolonomyDocumentationError) throw error
    throw new HolonomyDocumentationError('The requested Holonomy documentation file is unavailable')
  } finally {
    if (descriptor != null) {
      try {
        closeSync(descriptor)
      } catch {
        // The read result or stable read error remains authoritative.
      }
    }
  }
}

export const readHolonomyDocumentation = (input, options = {}) => {
  const [command, ...arguments_] = input
  if (
    command !== '--help' && command !== '-h' && command !== 'help' && command !== '--readme' && command !== '--llms'
  ) {
    return undefined
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    if (arguments_.length !== 0) throw new Error('Holonomy help does not accept additional arguments')
    return help
  }
  if (arguments_.length > 1) throw new Error('Holonomy --readme/--llms accepts at most one Markdown path')
  const path = arguments_[0] == null
    ? resolve(root, 'tools/README.md')
    : resolve(options.cwd ?? process.cwd(), arguments_[0])
  return readMarkdown(path)
}
