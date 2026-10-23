import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const safe = value =>
  typeof value === 'string' && /^[\w%+@./-]+$/u.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..')
const filesFor = manifest => [...Object.keys(manifest.files), 'manifest.json'].sort()

export const nativeArchiveMembers = (name, manifest) => {
  if (!safe(name) || name.includes('/')) throw new Error('Invalid native archive root')
  const files = filesFor(manifest)
  if (files.length > 20_000 || new Set(files).size !== files.length || files.some(file => !safe(file))) {
    throw new Error('Invalid native archive file inventory')
  }
  const members = new Set([`${name}/`])
  for (const file of files) {
    members.add(`${name}/${file}`)
    const parts = file.split('/')
    for (let count = 1; count < parts.length; count += 1) {
      members.add(`${name}/${parts.slice(0, count).join('/')}/`)
    }
  }
  for (const file of files) {
    if (members.has(`${name}/${file}/`)) throw new Error('Native archive path type collision')
  }
  return [...members].sort()
}

export const verifyNativeArchiveMembers = (members, name, manifest) => {
  const expected = nativeArchiveMembers(name, manifest)
  if (
    members.length !== expected.length || new Set(members).size !== members.length ||
    JSON.stringify([...members].sort()) !== JSON.stringify(expected)
  ) {
    throw new Error('Native archive has extra, duplicate or missing members')
  }
}

export const verifyNativeBundleInventory = async ({ bundle, manifest }) => {
  const root = await lstat(bundle)
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Native bundle root must be a real directory')
  const name = basename(bundle)
  const actual = [`${name}/`]
  const visit = async relative => {
    for (const leaf of await readdir(join(bundle, relative))) {
      const path = relative ? `${relative}/${leaf}` : leaf
      if (!safe(path)) throw new Error('Invalid native bundle path')
      const metadata = await lstat(join(bundle, path))
      if (metadata.isSymbolicLink()) throw new Error('Native bundle symlinks are unsupported')
      if (metadata.isDirectory()) {
        actual.push(`${name}/${path}/`)
        await visit(path)
      } else if (metadata.isFile() && metadata.nlink === 1) actual.push(`${name}/${path}`)
      else throw new Error('Native bundle contains a nonregular or hardlinked member')
    }
  }
  await visit('')
  verifyNativeArchiveMembers(actual, name, manifest)
}

const tar = (args, cwd, input) => {
  const result = spawnSync('/usr/bin/tar', args, {
    cwd,
    input,
    env: { PATH: '', COPYFILE_DISABLE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  })
  if (result.error || result.status !== 0) throw new Error('Native archive command failed')
  return result.stdout
}

const sealMetadata = async (bundle, members, name) => {
  for (const member of [...members].sort((a, b) => b.length - a.length)) {
    const relative = member.slice(name.length + 1).replace(/\/$/u, '')
    const directory = member.endsWith('/')
    const file = await open(
      join(bundle, relative),
      constants.O_RDONLY | constants.O_NOFOLLOW |
        constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    )
    try {
      const metadata = await file.stat()
      if (directory ? !metadata.isDirectory() : !metadata.isFile() || metadata.nlink !== 1) {
        throw new Error('Native staging member changed')
      }
      const privatePath = relative === 'private' || relative.startsWith('private/')
      const executable = relative === 'bin/holo' || relative === 'configure-v86.sh'
      await file.chmod(directory ? privatePath ? 0o700 : 0o755 : privatePath ? 0o600 : executable ? 0o755 : 0o644)
      await file.utimes(0, 0)
    } finally {
      await file.close()
    }
  }
}

export const createNativeArchive = async ({ bundle, manifest, archive }) => {
  await verifyNativeBundleInventory({ bundle, manifest })
  const name = basename(bundle)
  const members = nativeArchiveMembers(name, manifest)
  await sealMetadata(bundle, members, name)
  tar(
    [
      '-czf',
      archive,
      '--format',
      'ustar',
      '--no-mac-metadata',
      '--no-xattrs',
      '--no-acls',
      '--no-fflags',
      '--uid',
      '0',
      '--gid',
      '0',
      '--numeric-owner',
      '--options',
      'gzip:!timestamp',
      '--no-recursion',
      '-C',
      dirname(bundle),
      '-T',
      '-'
    ],
    dirname(bundle),
    `${members.join('\n')}\n`
  )
  verifyNativeArchiveMembers(tar(['-tzf', archive], dirname(bundle)).trimEnd().split('\n'), name, manifest)
}
