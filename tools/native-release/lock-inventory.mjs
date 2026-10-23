import { Buffer } from 'node:buffer'

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const field = (block, name) => block.match(new RegExp(`^${name} = "([^"\\n]+)"$`, 'mu'))?.[1]

export const parseCargoInventory = source => {
  if (!/^version = 4$/mu.test(source)) throw new Error('Unsupported Cargo.lock version')
  const blocks = source.split(/(?=^\[\[package\]\]$)/mu).filter(value => value.startsWith('[[package]]'))
  if (blocks.length === 0) throw new Error('Cargo.lock has no packages')
  const seen = new Set()
  return blocks.map(block => {
    const name = field(block, 'name')
    const version = field(block, 'version')
    const source = field(block, 'source') ?? null
    const checksum = field(block, 'checksum') ?? null
    if (!name || !version || (source?.startsWith('registry+') && !digest(checksum))) {
      throw new Error('Invalid Cargo.lock package identity or checksum')
    }
    const key = `${name}@${version}:${source ?? 'workspace'}`
    if (seen.has(key)) throw new Error('Duplicate Cargo.lock package')
    seen.add(key)
    return { name, version, source, checksum }
  })
}

export const parsePnpmInventory = source => {
  if (!/^lockfileVersion: '9\.0'$/mu.test(source)) throw new Error('Unsupported pnpm lock version')
  const section = source.match(/^packages:\n([\s\S]*?)^snapshots:$/mu)?.[1]
  if (section == null) throw new Error('Missing pnpm package section')
  const blocks = section.split(/(?=^ {2}(?:'[^']+'|\S.*):$)/mu)
    .filter(value => /^ {2}(?:'[^']+'|\S.*):$/mu.test(value.split('\n', 1)[0]))
  if (blocks.length === 0) throw new Error('pnpm lock has no packages')
  const seen = new Set()
  return blocks.map(block => {
    const raw = block.split('\n', 1)[0].slice(2, -1)
    const identity = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw
    const at = identity.lastIndexOf('@')
    const name = identity.slice(0, at)
    const version = identity.slice(at + 1)
    const resolution = block.match(/^ {4}resolution: \{(.+)\}$/mu)?.[1] ?? ''
    const integrity = resolution.match(/(?:^|, )integrity: (sha512|sha256|sha1)-([A-Za-z0-9+/]+=*)/u)
    const tarball = resolution.match(/(?:^|, )tarball: (https:\/\/[^,}]+)/u)?.[1] ?? null
    if (!name || !version || seen.has(identity)) throw new Error('Invalid pnpm package identity')
    seen.add(identity)
    const checksum = integrity == null ? null : {
      algorithm: integrity[1].toUpperCase(),
      value: Buffer.from(integrity[2], 'base64').toString('hex')
    }
    if (
      integrity == null || tarball == null ||
      checksum.value.length !== { SHA512: 128, SHA256: 64, SHA1: 40 }[checksum.algorithm] ||
      Buffer.from(checksum.value, 'hex').toString('base64') !== integrity[2]
    ) {
      throw new Error('Missing or invalid pnpm package integrity')
    }
    return { name, version, tarball, checksum }
  })
}
