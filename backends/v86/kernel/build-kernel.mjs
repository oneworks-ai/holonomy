import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { verifyV86KernelConfigFileV1 } from './kernel-config.mjs'

const main = async () => {
  const [sourceInput, outputInput] = process.argv.slice(2)
  if (sourceInput == null || outputInput == null) {
    throw new TypeError('Usage: node build-kernel.mjs <linux-source> <output-directory>')
  }
  if (process.platform !== 'linux') throw new Error('The v86 Linux kernel must be built on Linux')

  const sourceRoot = resolve(sourceInput)
  const outputRoot = resolve(outputInput)
  const manifest = JSON.parse(readFileSync(new URL('./linux-source.json', import.meta.url), 'utf8'))
  if (
    Object.keys(manifest).sort().join(',') !== 'repository,revision,schemaVersion,tag' ||
    manifest.schemaVersion !== 1 || !/^[a-f\d]{40}$/u.test(manifest.revision)
  ) throw new Error('Invalid pinned Linux source manifest')
  const revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['-C', sourceRoot, 'status', '--porcelain'], { encoding: 'utf8' })
  if (revision !== manifest.revision || dirty !== '') {
    throw new Error('Linux source identity does not match the pinned clean revision')
  }

  const fragment = resolve(dirname(fileURLToPath(import.meta.url)), 'holonomy-v86.fragment')
  const mergeConfig = resolve(sourceRoot, 'scripts/kconfig/merge_config.sh')
  mkdirSync(outputRoot, { recursive: true })
  const make = (...args) =>
    execFileSync('make', ['-C', sourceRoot, `O=${outputRoot}`, 'ARCH=x86', ...args], {
      stdio: 'inherit'
    })
  make('i386_defconfig')
  execFileSync(mergeConfig, ['-m', '-O', outputRoot, resolve(outputRoot, '.config'), fragment], {
    stdio: 'inherit'
  })
  make('olddefconfig')
  await verifyV86KernelConfigFileV1(resolve(outputRoot, '.config'))
  make('bzImage')

  const kernelPath = resolve(outputRoot, 'arch/x86/boot/bzImage')
  const kernel = readFileSync(kernelPath)
  process.stdout.write(`${
    JSON.stringify({
      architecture: 'i386',
      path: kernelPath,
      sha256: createHash('sha256').update(kernel).digest('hex'),
      size: kernel.byteLength,
      sourceRepository: manifest.repository,
      sourceRevision: revision,
      sourceTag: manifest.tag
    })
  }\n`)
}

void main()
