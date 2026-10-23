import { existsSync, lstatSync, opendirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { parse } from 'acorn'

const listFiles = directory => {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries.flatMap(entry => {
    const target = resolve(directory, entry.name)
    return entry.isDirectory() ? listFiles(target) : [target]
  })
}

const globExpression = pattern =>
  new RegExp(
    `^${
      pattern
        .split(sep).join('/')
        .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
        .replace(/\*\*\//gu, '__HOLONOMY_GLOBSTAR_DIRECTORY__')
        .replace(/\*\*/gu, '__HOLONOMY_GLOBSTAR__')
        .replace(/\*/gu, '[^/]*')
        .replace(/__HOLONOMY_GLOBSTAR_DIRECTORY__/gu, '(?:.*/)?')
        .replace(/__HOLONOMY_GLOBSTAR__/gu, '.*')
    }$`,
    'u'
  )

// Discovery reads only Host metadata. Native remains the byte/source-role owner.
const listNativeFiles = (directory, budget) => {
  const pending = [directory]
  const files = []
  while (pending.length > 0) {
    const current = pending.pop()
    if (current.split(sep).some(segment => segment.toLowerCase() === 'node_modules')) continue
    let metadata
    try {
      metadata = lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (metadata.isSymbolicLink()) throw new Error('Native entry discovery does not follow symbolic links')
    if (!metadata.isDirectory()) continue
    if (++budget.directories > 1024) throw new Error('Native entry discovery exceeds its directory limit')
    const handle = opendirSync(current)
    try {
      for (let entry = handle.readSync(); entry != null; entry = handle.readSync()) {
        if (++budget.entries > 16_384) throw new Error('Native entry discovery exceeds its entry limit')
        if (entry.name.toLowerCase() === 'node_modules' || entry.isSymbolicLink()) continue
        const target = resolve(current, entry.name)
        if (entry.isDirectory()) pending.push(target)
        else if (entry.isFile()) files.push(target)
      }
    } finally {
      handle.closeSync()
    }
  }
  return files
}

export const expandHolonomyEntries = (patterns, options = {}) => {
  const files = new Set()
  const native = options.native === true
  const budget = { directories: 0, entries: 0 }
  const discover = directory => native ? listNativeFiles(directory, budget) : listFiles(directory)
  const add = file => {
    files.add(file)
    if (native && files.size > 256) throw new Error('Native entry discovery exceeds its file limit')
  }
  for (const pattern of patterns) {
    const absolute = resolve(pattern)
    if (existsSync(absolute)) {
      const metadata = native ? lstatSync(absolute) : statSync(absolute)
      if (native && metadata.isSymbolicLink()) throw new Error('Native entry must not be a symbolic link')
      if (metadata.isDirectory()) {
        for (const file of discover(absolute)) {
          if ((native ? /\.(?:c|m)?js$/u : /\.m?js$/u).test(file)) add(file)
        }
      } else {
        if (native && !metadata.isFile()) throw new Error('Native entry must be a regular file')
        add(absolute)
      }
      continue
    }
    const wildcard = absolute.indexOf('*')
    if (wildcard < 0) continue
    const prefix = absolute.slice(0, wildcard)
    const searchRoot = prefix.endsWith(sep) ? resolve(prefix) : dirname(prefix)
    const expression = globExpression(resolve(pattern).split(sep).join('/'))
    for (const file of discover(searchRoot)) {
      if (expression.test(file.split(sep).join('/'))) add(file)
    }
  }
  if (files.size === 0) throw new Error('No JavaScript input files matched')
  return [...files].sort()
}

const dependencies = source => {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const output = []
  const stack = [ast]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node == null || typeof node !== 'object') continue
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
        node.type === 'ExportNamedDeclaration') && typeof node.source?.value === 'string'
    ) output.push(node.source.value)
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') output.push(node.source.value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value)
      else if (value != null && typeof value === 'object') stack.push(value)
    }
  }
  return output
}

const moduleUrl = (file, rootUrl) => {
  const path = relative(process.cwd(), file).split(sep).join('/')
  if (path === '..' || path.startsWith('../')) throw new Error(`Module is outside the working directory: ${file}`)
  return new URL(path, rootUrl).toString()
}

export const collectHolonomyGraph = (entries, rootUrl) => {
  const modules = new Map()
  const visit = file => {
    const absolute = resolve(file)
    const url = moduleUrl(absolute, rootUrl)
    if (modules.has(url)) return url
    const source = readFileSync(absolute, 'utf8')
    modules.set(url, { source, url })
    for (const specifier of dependencies(source)) {
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('.')) throw new Error(`Unsupported bare import ${specifier} in ${absolute}`)
      visit(resolve(dirname(absolute), specifier))
    }
    return url
  }
  return { entryUrls: entries.map(visit), modules }
}
