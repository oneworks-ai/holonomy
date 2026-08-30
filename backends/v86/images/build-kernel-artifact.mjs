import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { canonicalJson, normalizeKernelLockV1, sha256 } from './image-contract.mjs'

const [outputInput, cacheInput] = process.argv.slice(2)
if (outputInput == null) {
  throw new TypeError('Usage: node build-kernel-artifact.mjs <output-dir> [cache-dir]')
}
const outputRoot = resolve(outputInput)
const cacheRoot = resolve(cacheInput ?? join(tmpdir(), 'holonomy-v86-image-cache-v1'))
const lock = normalizeKernelLockV1(JSON.parse(
  await readFile(new URL('./alpine-kernel-lock-v1.json', import.meta.url), 'utf8')
))

const download = async () => {
  await mkdir(cacheRoot, { recursive: true })
  const target = join(cacheRoot, lock.package.sha256)
  try {
    const current = await readFile(target)
    if (sha256(current) === lock.package.sha256) return target
  } catch {}
  const response = await fetch(lock.package.url)
  if (!response.ok) throw new Error('v86 kernel download failed')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== lock.package.sha256) throw new Error('v86 kernel package digest mismatch')
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await rename(temporary, target)
  return target
}

const archive = await download()
const extracted = spawnSync('tar', ['-xOzf', archive, lock.kernel.archivePath], {
  maxBuffer: 32 * 1024 * 1024
})
if (extracted.status !== 0) throw new Error('v86 kernel extraction failed')
const kernel = new Uint8Array(extracted.stdout)
if (sha256(kernel) !== lock.kernel.sha256) throw new Error('v86 kernel digest mismatch')
const manifest = Object.freeze({
  architecture: 'linux-x86-32',
  artifact: Object.freeze({ name: 'kernel.bin', sha256: lock.kernel.sha256, size: kernel.byteLength }),
  package: lock.package,
  release: lock.release,
  schemaVersion: 1
})
await mkdir(outputRoot, { recursive: true })
await Promise.all([
  writeFile(join(outputRoot, 'kernel.bin'), kernel, { mode: 0o444 }),
  writeFile(join(outputRoot, 'kernel.manifest.json'), canonicalJson(manifest), { mode: 0o444 })
])
process.stdout.write(canonicalJson({
  kernel: join(outputRoot, 'kernel.bin'),
  manifest: join(outputRoot, 'kernel.manifest.json'),
  sha256: lock.kernel.sha256,
  size: kernel.byteLength
}))
