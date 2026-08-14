import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { verifyRfcSemantics } from './verify-rfc-contract-semantics.mjs'

const chapter = '0001-holo-capability-runtime'
export const RFC_CONTRACT_FILES = [
  '0001-holo-capability-runtime.md',
  ...[
    'capability-definitions.md',
    'core-contract-types.md',
    'device-and-filesystem.md',
    'device-events-v1.md',
    'device-provider-contract.md',
    'device-schema-v1.md',
    'device-value-types-v1.md',
    'engine-gate-and-realms.md',
    'engine-security.md',
    'error-contract-v1.md',
    'facades-and-invocation-modes.md',
    'filesystem-operation-registry.md',
    'filesystem-schema-v1.md',
    'host-system-projection.md',
    'host-system-value-types.md',
    'middleware.md',
    'milestones.md',
    'modules-and-context.md',
    'network-and-node-errors.md',
    'network-operation-registry.md',
    'network-schema-v1.md',
    'observer-contract-v1.md',
    'platform-lifecycle-and-security.md',
    'policy-and-capabilities.md',
    'policy-limits-v2.md',
    'process-and-linux-backend.md',
    'process-operation-registry.md',
    'process-resource-protocol.md',
    'resource-resolution.md',
    'resources-and-snapshots.md',
    'runtime-plugins-and-watch.md',
    'system-operation-registry.md',
    'verification-and-rollout.md'
  ].map(name => `${chapter}/${name}`)
]

const staleLiterals = [
  'holonomy-fs://',
  'holo.permission_timeout',
  'device.connectivity.summary.read',
  'device.connectivity.wifi.signal.read',
  'device.power.summary.read',
  'device.display.summary.read',
  'device.network.interfaces.read',
  'ERR_FS_WATCHER_LIMIT'
]

function markdownAnchors(source) {
  const anchors = new Set()
  const duplicates = new Map()
  for (const line of source.split('\n')) {
    const markerEnd = line.indexOf(' ')
    const marker = line.slice(0, markerEnd)
    if (markerEnd < 2 || marker.length > 6 || !/^#+$/.test(marker)) continue
    const base = line.slice(markerEnd + 1).toLowerCase().replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim().replace(/\s+/g, '-')
    const count = duplicates.get(base) ?? 0
    duplicates.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

function tsFences(source) {
  return [...source.matchAll(/```(?:ts|typescript)\n([\s\S]*?)```/g)]
    .map(match => match[1])
}

function compileTypescript(code) {
  const fileName = resolve('/virtual/rfc-0001-contract.ts')
  const modulesName = resolve('/virtual/rfc-0001-modules.d.ts')
  const options = {
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    noEmit: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022
  }
  const prelude = `declare const handler:any,nativeFs:any,runtime:any,application:any;
declare const hostApplication:any,applicationGrantStore:any;
declare function createPermissionMiddleware(options:any):any;
interface MyApplicationContext{}\n`
  const modules = `declare module 'holo:device'{export const getWifiState:any}
declare module 'holo:device/promises'{export const getWifiState:any}
declare module 'holo:runtime'{export function getContext<T>():T}\n`
  const source = `${prelude}\n${code}`
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = name => name === fileName || name === modulesName || ts.sys.fileExists(name)
  host.readFile = name => name === fileName ? source : name === modulesName ? modules : ts.sys.readFile(name)
  host.getSourceFile = (name, languageVersion, ...rest) => {
    if (name === fileName) return ts.createSourceFile(name, source, languageVersion, true)
    if (name === modulesName) return ts.createSourceFile(name, modules, languageVersion, true)
    return getSourceFile(name, languageVersion, ...rest)
  }
  const program = ts.createProgram([fileName, modulesName], options, host)
  return { diagnostics: ts.getPreEmitDiagnostics(program), sourceFile: program.getSourceFile(fileName) }
}

export async function verifyRfcContract(rfcRoot) {
  const failures = []
  const expected = [...RFC_CONTRACT_FILES].sort()
  const actual = [
    '0001-holo-capability-runtime.md',
    ...(await readdir(join(rfcRoot, chapter))).filter(name => name.endsWith('.md'))
      .map(name => `${chapter}/${name}`)
  ].sort()
  if (actual.join('\n') !== expected.join('\n')) {
    failures.push(`RFC manifest differs from exact ${RFC_CONTRACT_FILES.length}-file contract`)
  }
  const sources = new Map()
  const rootReal = await realpath(rfcRoot)
  for (const name of expected) {
    const path = join(rfcRoot, name)
    try {
      const info = await lstat(path)
      const resolved = await realpath(path)
      if (info.isSymbolicLink() || !resolved.startsWith(`${rootReal}${sep}`)) failures.push(`${name}: unsafe path`)
      const source = await readFile(path, 'utf8')
      sources.set(name, source)
      if (source.split('\n').length - 1 > 200) failures.push(`${name}: exceeds 200 lines`)
    } catch {
      failures.push(`${name}: required RFC file is missing`)
    }
  }
  const edges = new Map(expected.map(name => [name, new Set()]))
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/\]\(([^)#]+\.md)(?:#([^)]+))?\)/g)) {
      const targetPath = resolve(rfcRoot, dirname(name), match[1])
      const targetName = relative(rfcRoot, targetPath).split(sep).join('/')
      if (!expected.includes(targetName)) {
        failures.push(`${name}: link outside manifest: ${match[1]}`)
        continue
      }
      edges.get(name).add(targetName)
      if (match[2] && !markdownAnchors(sources.get(targetName) ?? '').has(match[2])) {
        failures.push(`${name}: missing anchor ${match[2]}`)
      }
    }
    for (const match of source.matchAll(/```json\n([\s\S]*?)```/g)) {
      try {
        JSON.parse(match[1])
      } catch {
        failures.push(`${name}: invalid JSON example`)
      }
    }
  }
  const reached = new Set()
  const pending = ['0001-holo-capability-runtime.md']
  while (pending.length) {
    const name = pending.pop()
    if (reached.has(name)) continue
    reached.add(name)
    pending.push(...(edges.get(name) ?? []))
  }
  const overviewLinks = edges.get('0001-holo-capability-runtime.md')
  for (const name of expected) {
    if (name !== '0001-holo-capability-runtime.md' && !overviewLinks.has(name)) {
      failures.push(`${name}: missing direct RFC overview link`)
    }
    if (!reached.has(name)) failures.push(`${name}: unreachable from RFC overview`)
  }
  const allSource = [...sources.values()].join('\n')
  for (const literal of staleLiterals) {
    if (allSource.includes(literal)) failures.push(`forbidden stale literal: ${literal}`)
  }
  const code = [...sources.values()].flatMap(tsFences).join('\n')
  const declarationOwners = new Map()
  for (const [name, source] of sources) {
    for (const fence of tsFences(source)) {
      for (const match of fence.matchAll(/\b(?:type|interface|class|enum)\s+([A-Za-z_$][\w$]*)\b/g)) {
        if (declarationOwners.has(match[1])) {
          failures.push(`duplicate type owner: ${match[1]} (${declarationOwners.get(match[1])}, ${name})`)
        } else declarationOwners.set(match[1], name)
      }
    }
  }
  const compilation = compileTypescript(code)
  for (const diagnostic of compilation.diagnostics) {
    const position = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : undefined
    const location = position ? `${position.line + 1}:${position.character + 1}: ` : ''
    const excerpt = position ? ` [${diagnostic.file.text.split('\n')[position.line].trim()}]` : ''
    failures.push(`TypeScript: ${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}${excerpt}`)
  }
  verifyRfcSemantics(sources, allSource, compilation.sourceFile, failures)
  if (failures.length) {
    throw new Error(
      `RFC contract verification failed:\n${[...new Set(failures)].map(value => `- ${value}`).join('\n')}`
    )
  }
  return { declarations: declarationOwners.size }
}
