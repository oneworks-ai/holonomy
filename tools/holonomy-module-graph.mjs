import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { parse } from 'acorn'

const listFiles = directory =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = resolve(directory, entry.name)
    return entry.isDirectory() ? listFiles(target) : [target]
  })

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

export const expandHolonomyEntries = patterns => {
  const files = new Set()
  for (const pattern of patterns) {
    const absolute = resolve(pattern)
    if (existsSync(absolute)) {
      if (statSync(absolute).isDirectory()) {
        for (const file of listFiles(absolute)) if (/\.m?js$/u.test(file)) files.add(file)
      } else files.add(absolute)
      continue
    }
    const expression = globExpression(resolve(pattern).split(sep).join('/'))
    for (const file of listFiles(process.cwd())) {
      if (expression.test(file.split(sep).join('/'))) files.add(file)
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
