import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const sourcePath = new URL('./alpine-source-v1.json', import.meta.url)
const source = JSON.parse(await readFile(sourcePath, 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const download = async (url, expected) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (expected != null && digest(bytes) !== expected) throw new Error(`Digest mismatch: ${url}`)
  return bytes
}
const parseRecord = (value, repository) => {
  const fields = Object.fromEntries(value.split('\n').map(line => [line.slice(0, 1), line.slice(2)]))
  return Object.freeze({
    checksum: fields.C,
    dependencies: Object.freeze(fields.D?.split(' ').filter(Boolean) ?? []),
    installedBytes: Number(fields.I),
    license: fields.L,
    name: fields.P,
    provides: Object.freeze(fields.p?.split(' ').filter(Boolean) ?? []),
    repository,
    size: Number(fields.S),
    version: fields.V
  })
}
const indexes = []
for (const repository of source.repositories) {
  const url = `${repository.baseUrl}/APKINDEX.tar.gz`
  const compressed = await download(url, repository.indexSha256)
  const response = await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')))
  const tar = new Uint8Array(await response.arrayBuffer())
  const marker = new TextEncoder().encode('C:')
  let text
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.slice(offset, offset + 512)
    const name = new TextDecoder().decode(header.slice(0, header.indexOf(0)))
    if (name === '') break
    const sizeText = new TextDecoder().decode(header.slice(124, 136)).replaceAll('\0', '').trim()
    const size = Number.parseInt(sizeText, 8)
    const body = tar.slice(offset + 512, offset + 512 + size)
    if (name === 'APKINDEX' && body[0] === marker[0] && body[1] === marker[1]) {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body)
      break
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (text == null) throw new Error(`Invalid APKINDEX archive: ${repository.id}`)
  indexes.push(...text.trim().split('\n\n').map(value => parseRecord(value, repository)))
}

const packages = new Map(indexes.map(value => [value.name, value]))
const providers = new Map()
const addProvider = (name, value) => {
  const current = providers.get(name) ?? []
  current.push(value)
  providers.set(name, current)
}
for (const value of indexes) {
  addProvider(value.name, value)
  for (const item of value.provides) addProvider(item.replace(/[=<>~].*$/u, ''), value)
}
const normalizeDependency = value => value.replace(/[=<>~].*$/u, '')
const resolveDependency = value => {
  if (value.startsWith('!') || value.startsWith('/')) return undefined
  const name = normalizeDependency(value)
  const exact = packages.get(name)
  if (exact != null) return exact
  const candidates = providers.get(name)
  if (candidates == null || candidates.length === 0) throw new Error(`Unresolved Alpine dependency: ${value}`)
  return [...candidates].sort((left, right) => left.name.localeCompare(right.name))[0]
}
const selected = new Map()
const pending = source.seedPackages.map(name => packages.get(name) ?? resolveDependency(name))
while (pending.length > 0) {
  const value = pending.shift()
  if (value == null || selected.has(value.name)) continue
  selected.set(value.name, value)
  for (const dependency of value.dependencies) {
    const resolved = resolveDependency(dependency)
    if (resolved != null && !selected.has(resolved.name)) pending.push(resolved)
  }
}
const locked = []
for (const value of [...selected.values()].sort((left, right) => left.name.localeCompare(right.name))) {
  const url = `${value.repository.baseUrl}/${value.name}-${value.version}.apk`
  const bytes = await download(url)
  locked.push(Object.freeze({
    dependencies: value.dependencies,
    installedBytes: value.installedBytes,
    license: value.license,
    name: value.name,
    provides: value.provides,
    repository: value.repository.id,
    sha256: digest(bytes),
    size: bytes.byteLength,
    url,
    version: value.version
  }))
}
process.stdout.write(`${
  JSON.stringify(
    {
      architecture: source.architecture,
      packages: locked,
      rootfs: source.rootfs,
      schemaVersion: 1,
      sourceIndexes: source.repositories.map(({ baseUrl, id, indexSha256 }) => ({ baseUrl, id, indexSha256 }))
    },
    null,
    2
  )
}\n`)
