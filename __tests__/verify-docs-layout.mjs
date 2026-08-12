import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultDocsRoot = resolve(repositoryRoot, '.oo/docs')
const readmePattern = /^README(?:\.[^.]+)?\.md$/iu
const inertImageExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp'])
const inertVideoExtensions = new Set(['.mp4', '.webm'])
const authoredNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)?$/u

const normalizedRelative = (root, file) => relative(root, file).split(sep).join('/')
const isConfined = (root, target) => {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

const collectFiles = (docsRoot, errors) => {
  const rootStat = lstatSync(docsRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Documentation root must be a real directory')
  }
  const realRoot = realpathSync(docsRoot)
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = resolve(directory, entry.name)
      const path = normalizedRelative(docsRoot, target)
      if (entry.name.startsWith('.')) {
        errors.push(`${path}: hidden documentation paths are forbidden`)
        continue
      }
      if (path !== 'AGENTS.md' && !authoredNamePattern.test(entry.name)) {
        errors.push(`${path}: authored paths must use lowercase ASCII kebab-case`)
        continue
      }
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) {
        errors.push(`${path}: symbolic links are forbidden`)
        continue
      }
      if (stat.isDirectory()) {
        visit(target)
        continue
      }
      if (!stat.isFile()) {
        errors.push(`${path}: only regular authored files are allowed`)
        continue
      }
      if (!isConfined(realRoot, realpathSync(target))) {
        errors.push(`${path}: real path escapes documentation root`)
        continue
      }
      const extension = extname(target).toLowerCase()
      const isRootGuide = path === 'AGENTS.md'
      if (readmePattern.test(basename(target))) errors.push(`${path}: README placeholders are forbidden`)
      else if (extension === '.md' && (basename(target) !== 'AGENTS.md' || isRootGuide)) files.push(target)
      else if (inertImageExtensions.has(extension) && path.startsWith('images/')) files.push(target)
      else if (inertVideoExtensions.has(extension) && path.startsWith('videos/')) files.push(target)
      else errors.push(`${path}: file type or media location is not allowed`)
    }
  }
  visit(docsRoot)
  return files
}

const stripHtmlComments = (source, errors, label) => {
  let clean = ''
  let cursor = 0
  while (cursor < source.length) {
    const open = source.indexOf('<!--', cursor)
    if (open < 0) return clean + source.slice(cursor)
    clean += source.slice(cursor, open)
    const close = source.indexOf('-->', open + 4)
    if (close < 0) {
      errors.push(`${label}: unbalanced HTML comment`)
      return clean
    }
    cursor = close + 3
  }
  return clean
}

const scanLinkTargets = (line, links, references, shortcutReferences, errors, label) => {
  const definition = line.match(/^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/u)
  if (definition) references.set(definition[1].trim().toLowerCase(), definition[2] ?? definition[3])
  for (const match of line.matchAll(/\[([^\]]+)\]\((?=.)/gu)) {
    let depth = 1
    let cursor = match.index + match[0].length
    let target = ''
    for (; cursor < line.length && depth > 0; cursor += 1) {
      const character = line[cursor]
      if (character === '\\') {
        target += `${character}${line[cursor + 1] ?? ''}`
        cursor += 1
      } else if (character === '(') {
        depth += 1
        target += character
      } else if (character === ')') {
        depth -= 1
        if (depth > 0) target += character
      } else target += character
    }
    if (depth === 0) links.push(target.trim())
    else errors.push(`${label}: unclosed Markdown link`)
  }
  for (const match of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/gu)) {
    references.set(`__use__${references.size}`, (match[2] || match[1]).trim().toLowerCase())
  }
  for (const match of line.matchAll(/(?<!!)\[([^\]]+)\]/gu)) {
    const next = line[match.index + match[0].length]
    if (['[', '(', ':'].includes(next)) continue
    shortcutReferences.push(match[1].trim().toLowerCase())
  }
}

const slugifyHeading = value =>
  value
    .toLowerCase()
    .replace(/[`*_~]/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-')

const normalizeMermaidLine = source => {
  let line = source.trim()
  const words = line.split(/\s+/u)
  if (['actor', 'participant'].includes(words[0])) line = `${words[0]} ${words[1]}`
  line = line
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/\[(?!\*)[^\]]*\]/gu, '[]')
    .replace(/\{[^}]*\}/gu, '{}')
    .replace(/\([^)]*\)/gu, '()')
    .replace(/\|[^|]*\|/gu, '')
    .replace(/-\.\s*""\s*\.->/gu, '-.->')
  const message = line.indexOf(':')
  if (message >= 0) line = line.slice(0, message + 1)
  return line.replace(/\s+/gu, ' ')
}

const normalizeMermaid = lines =>
  lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('%%'))
    .map(normalizeMermaidLine)
    .join('\n')

const analyzeMarkdown = (source, label, errors) => {
  const clean = stripHtmlComments(source, errors, label)
  const headings = []
  const anchors = new Set()
  const links = []
  const references = new Map()
  const shortcutReferences = []
  const mermaidTopology = []
  let fence
  let mermaidLines
  let inlineDelimiter
  let mermaidCount = 0
  let tableRows = 0
  for (const line of clean.split(/\r?\n/gu)) {
    const trimmed = line.trimStart()
    const fenceCharacter = trimmed[0] === '`' || trimmed[0] === '~' ? trimmed[0] : undefined
    let fenceLength = 0
    if (fenceCharacter) {
      while (trimmed[fenceLength] === fenceCharacter) fenceLength += 1
    }
    if (fenceLength >= 3) {
      if (!fence) {
        fence = { character: fenceCharacter, length: fenceLength }
        if (trimmed.slice(fenceLength).trim() === 'mermaid') {
          mermaidCount += 1
          mermaidLines = []
        }
      } else if (
        fence.character === fenceCharacter &&
        fenceLength >= fence.length &&
        !trimmed.slice(fenceLength).trim()
      ) {
        fence = undefined
        if (mermaidLines) mermaidTopology.push(normalizeMermaid(mermaidLines))
        mermaidLines = undefined
      } else if (mermaidLines) mermaidLines.push(line)
      continue
    }
    if (fence) {
      if (mermaidLines) mermaidLines.push(line)
      continue
    }
    let visible = ''
    for (let index = 0; index < line.length;) {
      if (line[index] !== '`' || line[index - 1] === '\\') {
        if (!inlineDelimiter) visible += line[index]
        index += 1
        continue
      }
      let end = index
      while (line[end] === '`') end += 1
      const delimiter = end - index
      if (!inlineDelimiter) inlineDelimiter = delimiter
      else if (inlineDelimiter === delimiter) inlineDelimiter = undefined
      index = end
    }
    if (/^\s*\|/u.test(visible)) tableRows += 1
    const heading = visible.match(/^(#{1,6})[\t ]+/u)
    if (heading) {
      headings.push(heading[1].length)
      let headingText = visible.slice(heading[0].length).trim()
      while (headingText.endsWith('#')) headingText = headingText.slice(0, -1).trimEnd()
      let anchor = slugifyHeading(headingText)
      let suffix = 1
      const base = anchor
      while (anchors.has(anchor)) anchor = `${base}-${suffix++}`
      anchors.add(anchor)
    }
    scanLinkTargets(visible, links, references, shortcutReferences, errors, label)
  }
  if (fence) errors.push(`${label}: unclosed fenced code block`)
  if (inlineDelimiter) errors.push(`${label}: unclosed inline code span`)
  for (const [key, reference] of references) {
    if (!key.startsWith('__use__')) continue
    const target = references.get(reference)
    if (target) links.push(target)
    else errors.push(`${label}: unresolved Markdown reference ${reference}`)
  }
  for (const reference of shortcutReferences) {
    const target = references.get(reference)
    if (target) links.push(target)
  }
  return { anchors, headings, links, mermaidCount, mermaidTopology, tableRows }
}

const linkTarget = rawTarget => {
  const trimmed = rawTarget.trim()
  const unwrapped = trimmed.startsWith('<') && trimmed.includes('>')
    ? trimmed.slice(1, trimmed.indexOf('>'))
    : trimmed.split(/\s+/u, 1)[0]
  const hash = unwrapped.indexOf('#')
  const fragment = hash >= 0 ? unwrapped.slice(hash + 1) : ''
  const withoutFragment = hash >= 0 ? unwrapped.slice(0, hash) : unwrapped
  return { fragment, path: withoutFragment.split('?', 1)[0] }
}

export const verifyDocsLayout = (docsRoot = defaultDocsRoot) => {
  const errors = []
  const allFiles = collectFiles(docsRoot, errors)
  const englishRoot = resolve(docsRoot, 'en')
  const markdown = allFiles.filter(file => extname(file) === '.md' && basename(file) !== 'AGENTS.md')
  const chinesePages = markdown.filter(file => !normalizedRelative(docsRoot, file).startsWith('en/'))
  const englishPages = markdown.filter(file => normalizedRelative(docsRoot, file).startsWith('en/'))
  const analyses = new Map(markdown.map(file => {
    const label = normalizedRelative(docsRoot, file)
    return [file, analyzeMarkdown(readFileSync(file, 'utf8'), label, errors)]
  }))
  const validatePair = (source, counterpart) => {
    const label = normalizedRelative(docsRoot, source)
    if (!existsSync(counterpart)) {
      errors.push(`${label}: missing locale counterpart`)
      return
    }
    const analysis = analyses.get(source)
    const paired = analyses.get(counterpart)
    if (
      !analysis.links.some(raw => {
        const target = linkTarget(raw).path
        try {
          return resolve(dirname(source), decodeURIComponent(target)) === counterpart
        } catch {
          return false
        }
      })
    ) errors.push(`${label}: missing visible counterpart link`)
    if (analysis.headings.join(',') !== paired.headings.join(',')) {
      errors.push(`${label}: heading structure differs from counterpart`)
    }
    if (analysis.mermaidCount !== paired.mermaidCount) errors.push(`${label}: Mermaid count differs from counterpart`)
    if (analysis.mermaidTopology.join('\n---\n') !== paired.mermaidTopology.join('\n---\n')) {
      errors.push(`${label}: Mermaid topology differs from counterpart`)
    }
    if (analysis.tableRows !== paired.tableRows) errors.push(`${label}: table structure differs from counterpart`)
  }
  for (const file of chinesePages) validatePair(file, resolve(englishRoot, normalizedRelative(docsRoot, file)))
  for (const file of englishPages) validatePair(file, resolve(docsRoot, normalizedRelative(englishRoot, file)))
  for (const file of markdown) {
    const label = normalizedRelative(docsRoot, file)
    const analysis = analyses.get(file)
    if (analysis.headings[0] !== 1) errors.push(`${label}: missing H1`)
    for (const raw of analysis.links) {
      const target = linkTarget(raw)
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(target.path)) continue
      let decoded
      try {
        decoded = decodeURIComponent(target.path)
      } catch {
        errors.push(`${label}: invalid encoded link ${raw}`)
        continue
      }
      const linkedFile = target.path ? resolve(dirname(file), decoded) : file
      if (!existsSync(linkedFile)) {
        errors.push(`${label}: broken link ${raw}`)
        continue
      }
      if (target.fragment && extname(linkedFile) === '.md') {
        const linked = analyses.get(linkedFile) ??
          analyzeMarkdown(readFileSync(linkedFile, 'utf8'), normalizedRelative(docsRoot, linkedFile), errors)
        let fragment
        try {
          fragment = decodeURIComponent(target.fragment).toLowerCase()
        } catch {
          errors.push(`${label}: invalid encoded anchor ${raw}`)
          continue
        }
        if (!linked.anchors.has(fragment)) errors.push(`${label}: broken anchor ${raw}`)
      }
    }
  }
  return {
    chinesePages: chinesePages.length,
    englishPages: englishPages.length,
    errors,
    publicMarkdown: markdown.length
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDocsLayout(process.argv[2] ? resolve(process.argv[2]) : defaultDocsRoot)
  if (result.errors.length > 0) throw new Error(`Invalid documentation layout:\n${result.errors.join('\n')}`)
  process.stdout.write(
    `Documentation layout: ${result.chinesePages} Chinese + ${result.englishPages} English pages, ${result.publicMarkdown} checked\n`
  )
}
