import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import process from 'node:process'

const [sourceRoot, outputRoot, externalRoot] = process.argv.slice(2)
if (sourceRoot == null || outputRoot == null || externalRoot == null) {
  throw new TypeError('prepare-v86-assets requires source, output and optional external roots')
}

const root = resolve(outputRoot, 'holonomy-host/process-backends/v86')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const entries = []
const record = (source, name, kind) => {
  const bytes = readFileSync(source)
  cpSync(source, resolve(root, name))
  entries.push({ bytes: bytes.length, kind, name, sha256: digest(bytes) })
}

rmSync(outputRoot, { force: true, recursive: true })
mkdirSync(root, { recursive: true })
for (
  const name of [
    'driver-network.mjs',
    'driver-sockets.mjs',
    'driver-support.mjs',
    'driver.mjs',
    'fuse-support.mjs',
    'fuse.mjs',
    'shim.mjs'
  ]
) {
  record(resolve(sourceRoot, name), name, 'runtime')
}
if (externalRoot !== '') {
  for (const name of ['libv86.mjs', 'v86.wasm', 'seabios.bin', 'kernel.bin', 'agent.cpio']) {
    record(resolve(externalRoot, name), name, 'backend')
  }
}
writeFileSync(
  resolve(root, 'backend-manifest.json'),
  `${
    JSON.stringify(
      {
        available: externalRoot !== '',
        entries: entries.sort((left, right) => left.name.localeCompare(right.name)),
        packageBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
        schemaVersion: 1,
        source: externalRoot === '' ? 'disabled' : basename(externalRoot)
      },
      null,
      2
    )
  }\n`
)
