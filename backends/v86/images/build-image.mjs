/* eslint-disable max-lines -- The image transaction is kept in one fail-closed orchestration unit. */
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'

import {
  canonicalJson,
  normalizeKernelLockV1,
  normalizePackageLockV1,
  readImageProfileV1,
  sha256
} from './image-contract.mjs'
import { createNewcArchiveV1 } from './newc.mjs'

const [selector, supervisorInput, outputInput, cacheInput] = process.argv.slice(2)
if (selector == null || supervisorInput == null || outputInput == null) {
  throw new TypeError('Usage: node build-image.mjs <profile-id|custom.json> <holo-uvd> <output-dir> [cache-dir]')
}
const profile = await readImageProfileV1(selector)
const lock = normalizePackageLockV1(JSON.parse(
  await readFile(new URL('./alpine-packages-lock-v1.json', import.meta.url), 'utf8')
))
const kernelLock = normalizeKernelLockV1(JSON.parse(
  await readFile(new URL('./alpine-kernel-lock-v1.json', import.meta.url), 'utf8')
))
const outputRoot = resolve(outputInput)
const cacheRoot = resolve(cacheInput ?? join(tmpdir(), 'holonomy-v86-image-cache-v1'))
const staging = await mkdtemp(join(tmpdir(), 'holonomy-v86-image-'))

const download = async ({ sha256: expected, url }) => {
  await mkdir(cacheRoot, { recursive: true })
  const target = join(cacheRoot, expected)
  try {
    const current = await readFile(target)
    if (sha256(current) === expected) return target
  } catch {}
  const response = await fetch(url)
  if (!response.ok) throw new Error(`v86 image download failed: ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== expected) throw new Error(`v86 image digest mismatch: ${url}`)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, target)
  return target
}
const extract = (archive, excludes = []) => {
  const result = spawnSync('tar', [
    '-xzf',
    archive,
    '-C',
    staging,
    ...excludes.flatMap(value => ['--exclude', value])
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`v86 image extraction failed: ${result.stderr}`)
}
const extractEntry = (archive, path) => {
  const result = spawnSync('tar', ['-xzf', archive, '-C', staging, path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`v86 image entry extraction failed: ${path}: ${result.stderr}`)
}
const dependencyName = value => value.replace(/[=<>~].*$/u, '')
const selectPackages = seeds => {
  const byName = new Map(lock.packages.map(value => [value.name, value]))
  const providers = new Map()
  const addProvider = (name, value) => providers.set(name, [...providers.get(name) ?? [], value])
  for (const value of lock.packages) {
    addProvider(value.name, value)
    for (const item of value.provides) addProvider(dependencyName(item), value)
  }
  const resolvePackage = dependency => {
    if (dependency.startsWith('!') || dependency.startsWith('/')) return undefined
    const name = dependencyName(dependency)
    const direct = byName.get(name)
    if (direct != null) return direct
    const candidates = providers.get(name)
    if (candidates == null || candidates.length === 0) throw new TypeError(`Unpinned package: ${dependency}`)
    return [...candidates].sort((left, right) => left.name.localeCompare(right.name))[0]
  }
  const selected = new Map()
  const pending = seeds.map(resolvePackage)
  while (pending.length > 0) {
    const value = pending.shift()
    if (value == null || selected.has(value.name)) continue
    selected.set(value.name, value)
    for (const dependency of value.dependencies) pending.push(resolvePackage(dependency))
  }
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name))
}
const installedPackages = async () => {
  try {
    const value = await readFile(join(staging, 'lib/apk/db/installed'), 'utf8')
    return value.trim().split('\n\n').map(record => {
      const fields = Object.fromEntries(record.split('\n').map(line => [line.slice(0, 1), line.slice(2)]))
      return Object.freeze({
        downloadLocation: 'NOASSERTION',
        license: fields.L ?? 'NOASSERTION',
        name: fields.P,
        version: fields.V
      })
    }).filter(value => value.name != null && value.version != null)
  } catch {
    return []
  }
}
const resolveInsideRoot = async path => {
  let target = posix.normalize(path)
  const seen = new Set()
  for (let index = 0; index < 32; index += 1) {
    if (!target.startsWith('/') || seen.has(target)) throw new TypeError(`Invalid image symlink: ${path}`)
    seen.add(target)
    const stats = await lstat(join(staging, target.slice(1)))
    if (!stats.isSymbolicLink()) return { stats, target }
    const link = await readlink(join(staging, target.slice(1)))
    target = posix.normalize(link.startsWith('/') ? link : posix.join(posix.dirname(target), link))
  }
  throw new TypeError(`Invalid image symlink: ${path}`)
}
const validateSupervisor = bytes => {
  if (
    bytes.byteLength < 20 || bytes[0] !== 0x7F || bytes[1] !== 0x45 || bytes[2] !== 0x4C || bytes[3] !== 0x46 ||
    bytes[4] !== 1 || bytes[5] !== 1 || bytes[18] !== 3 || bytes[19] !== 0
  ) throw new TypeError('holo-uvd must be a Linux i386 ELF')
}

try {
  await mkdir(staging, { recursive: true })
  if (profile.rootfs === 'alpine') extract(await download(lock.rootfs))
  const selected = selectPackages(profile.packages)
  for (const value of selected) {
    extract(await download(value), ['.SIGN.*', '.PKGINFO', '.post-*', '.pre-*', '.trigger'])
  }
  if (profile.rootfs === 'alpine') {
    const kernelArchive = await download(kernelLock.package)
    for (const module of kernelLock.modules) {
      extractEntry(kernelArchive, module.archivePath)
      const inputPath = join(staging, module.archivePath)
      const bytes = await readFile(inputPath)
      if (sha256(bytes) !== module.sha256) throw new Error(`v86 kernel module digest mismatch: ${module.name}`)
      if (module.archivePath.endsWith('.gz')) {
        const outputPath = inputPath.slice(0, -3)
        await writeFile(outputPath, gunzipSync(bytes), { mode: 0o444 })
        await rm(inputPath)
      }
    }
    const moduleRoot = join(staging, 'lib/modules', kernelLock.release)
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(
      join(moduleRoot, 'modules.dep'),
      `${
        kernelLock.modules.map(module => {
          const relative = value =>
            value.archivePath
              .slice(`lib/modules/${kernelLock.release}/`.length)
              .replace(/\.gz$/u, '')
          const dependencies = module.dependencies.map(name => {
            const dependency = kernelLock.modules.find(value => value.name === name)
            if (dependency == null) throw new Error(`Missing kernel module dependency: ${name}`)
            return relative(dependency)
          })
          return `${relative(module)}:${dependencies.length === 0 ? '' : ` ${dependencies.join(' ')}`}`
        }).join('\n')
      }\n`,
      { mode: 0o444 }
    )
  }
  for (const path of ['dev', 'etc/holo', 'home/holo', 'proc', 'sbin', 'sys', 'tmp', 'workspace']) {
    await mkdir(join(staging, path), { mode: path === 'tmp' ? 0o1777 : 0o755, recursive: true })
  }
  if (profile.rootfs === 'alpine') {
    const passwdPath = join(staging, 'etc/passwd')
    const groupPath = join(staging, 'etc/group')
    const passwd = await readFile(passwdPath, 'utf8')
    const group = await readFile(groupPath, 'utf8')
    if (/^[^:]+:[^:]*:1000:/mu.test(passwd) || /^[^:]+:[^:]*:1000:/mu.test(group)) {
      throw new TypeError('v86 image uid 1000 is already assigned')
    }
    await Promise.all([
      writeFile(passwdPath, `${passwd.trimEnd()}\nholo:x:1000:1000:Holonomy:/home/holo:/bin/sh\n`, { mode: 0o444 }),
      writeFile(groupPath, `${group.trimEnd()}\nholo:x:1000:\n`, { mode: 0o444 })
    ])
  }
  const supervisor = new Uint8Array(await readFile(supervisorInput))
  validateSupervisor(supervisor)
  await copyFile(supervisorInput, join(staging, 'sbin/holo-uvd'), constants.COPYFILE_FICLONE)
  await chmod(join(staging, 'sbin/holo-uvd'), 0o755)
  const capabilityClient = profile.executables.some(value => value.path === '/usr/bin/hoholo')
    ? new Uint8Array(await readFile(join(dirname(supervisorInput), 'hoholo')))
    : undefined
  if (capabilityClient != null) {
    validateSupervisor(capabilityClient)
    await mkdir(join(staging, 'usr/bin'), { recursive: true })
    await copyFile(join(dirname(supervisorInput), 'hoholo'), join(staging, 'usr/bin/hoholo'))
    await chmod(join(staging, 'usr/bin/hoholo'), 0o755)
  }
  const packages = new Map((await installedPackages()).map(value => [value.name, value]))
  for (const value of selected) {
    packages.set(value.name, {
      downloadLocation: value.url,
      license: value.license,
      name: value.name,
      sha256: value.sha256,
      version: value.version
    })
  }
  for (const executable of profile.executables) {
    const resolved = await resolveInsideRoot(executable.path)
    if (!resolved.stats.isFile() || (resolved.stats.mode & 0o111) === 0) {
      throw new TypeError(`Missing executable: ${executable.path}`)
    }
  }
  await access(join(staging, 'sbin/holo-uvd'), constants.X_OK)
  for (const fixture of ['holo-selftest', 'usr/bin/holo-v86-selftest']) {
    try {
      await access(join(staging, fixture))
      throw new TypeError('Production v86 images cannot contain the conformance selftest')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  const embedded = Object.freeze({
    architecture: 'linux-x86-32',
    executables: profile.executables,
    kernel: profile.rootfs === 'empty' ? null : kernelLock,
    packages: [...packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
    profileId: profile.id,
    rootfs: profile.rootfs === 'empty' ? null : lock.rootfs,
    schemaVersion: 1,
    supervisor: Object.freeze({ path: '/sbin/holo-uvd', sha256: sha256(supervisor) }),
    ...(capabilityClient == null
      ? {}
      : { capabilityClient: Object.freeze({ path: '/usr/bin/hoholo', sha256: sha256(capabilityClient) }) })
  })
  await writeFile(join(staging, 'etc/holo/image-profile-v1.json'), canonicalJson(embedded), { mode: 0o444 })
  const image = await createNewcArchiveV1(staging)
  const imageDigest = sha256(image)
  const spdx = Object.freeze({
    SPDXID: 'SPDXRef-DOCUMENT',
    creationInfo: Object.freeze({
      created: '1970-01-01T00:00:00Z',
      creators: Object.freeze(['Tool: Holonomy-v86-image-builder-v1'])
    }),
    dataLicense: 'CC0-1.0',
    documentNamespace: `https://holonomy.dev/spdx/v86/${profile.id}/${imageDigest}`,
    name: `Holonomy v86 ${profile.id}`,
    packages: embedded.packages.map((value, index) =>
      Object.freeze({
        SPDXID: `SPDXRef-Package-${index + 1}`,
        downloadLocation: value.downloadLocation,
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: value.license,
        name: value.name,
        versionInfo: value.version
      })
    ).concat(
      profile.rootfs === 'empty' ? [] : [Object.freeze({
        SPDXID: 'SPDXRef-Package-Kernel',
        downloadLocation: kernelLock.package.url,
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: kernelLock.package.license,
        name: kernelLock.package.name,
        versionInfo: kernelLock.package.version
      })]
    ),
    spdxVersion: 'SPDX-2.3'
  })
  const spdxBytes = new TextEncoder().encode(canonicalJson(spdx))
  const imageName = `${profile.id}.cpio`
  const spdxName = `${profile.id}.spdx.json`
  const manifestName = `${profile.id}.manifest.json`
  const manifest = Object.freeze({
    architecture: 'linux-x86-32',
    artifact: Object.freeze({ name: imageName, sha256: imageDigest, size: image.byteLength }),
    executables: profile.executables,
    kernel: profile.rootfs === 'empty' ? null : Object.freeze({
      modules: kernelLock.modules,
      packageSha256: kernelLock.package.sha256,
      release: kernelLock.release
    }),
    packageCount: embedded.packages.length + (profile.rootfs === 'empty' ? 0 : 1),
    profileDigest: sha256(new TextEncoder().encode(canonicalJson(profile))),
    profileId: profile.id,
    rootfs: profile.rootfs,
    schemaVersion: 1,
    sbom: Object.freeze({ name: spdxName, sha256: sha256(spdxBytes), size: spdxBytes.byteLength }),
    ...(capabilityClient == null ? {} : { capabilityClientSha256: sha256(capabilityClient) }),
    supervisorSha256: sha256(supervisor)
  })
  await mkdir(outputRoot, { recursive: true })
  await Promise.all([
    writeFile(join(outputRoot, imageName), image, { mode: 0o444 }),
    writeFile(join(outputRoot, manifestName), canonicalJson(manifest), { mode: 0o444 }),
    writeFile(join(outputRoot, spdxName), spdxBytes, { mode: 0o444 })
  ])
  process.stdout.write(`${
    canonicalJson({
      image: join(outputRoot, imageName),
      manifest: join(outputRoot, manifestName),
      profileId: profile.id,
      sbom: join(outputRoot, spdxName),
      sha256: imageDigest,
      size: image.byteLength
    })
  }`)
} finally {
  await rm(staging, { force: true, recursive: true })
}
