import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const [zigPath, outputRoot, selftestOption] = process.argv.slice(2)
if (zigPath == null || outputRoot == null || selftestOption != null && selftestOption !== '--include-selftest') {
  throw new TypeError('Usage: node build-supervisor.mjs <zig> <output-directory> [--include-selftest]')
}
if (execFileSync(zigPath, ['version'], { encoding: 'utf8' }).trim() !== '0.16.0') {
  throw new Error('The v86 supervisor requires Zig 0.16.0')
}

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'supervisor')
const binaryPath = resolve(outputRoot, 'holo-uvd')
const clientPath = resolve(outputRoot, 'hoholo')
const initrdPath = resolve(outputRoot, 'holo-uvd.cpio')
const selftestPath = resolve(outputRoot, 'holo-v86-selftest')
const sources = [
  'capability-bridge.c',
  'configuration.c',
  'exec-gate.c',
  'fuse-bridge.c',
  'main.c',
  'network.c',
  'protocol.c',
  'process.c',
  'process-loop.c',
  'process-parse.c',
  'process-payload.c'
].map(name => resolve(sourceRoot, name))
mkdirSync(outputRoot, { recursive: true })
execFileSync(zigPath, [
  'cc',
  '-target',
  'x86-linux-musl',
  '-static',
  '-O2',
  '-D_GNU_SOURCE',
  '-D_DEFAULT_SOURCE',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-o',
  binaryPath,
  ...sources
], { stdio: 'inherit' })
execFileSync(zigPath, [
  'cc',
  '-target',
  'x86-linux-musl',
  '-static',
  '-O2',
  '-D_GNU_SOURCE',
  '-D_DEFAULT_SOURCE',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-o',
  clientPath,
  resolve(sourceRoot, 'hoholo.c')
], { stdio: 'inherit' })
if (selftestOption != null) {
  execFileSync(zigPath, [
    'cc',
    '-target',
    'x86-linux-musl',
    '-nostdlib',
    '-static',
    '-Os',
    '-ffreestanding',
    '-fno-stack-protector',
    '-Wl,-e,_start',
    '-o',
    selftestPath,
    resolve(sourceRoot, 'selftest.c')
  ], { stdio: 'inherit' })
}

const align4 = value => (value + 3) & ~3
const hex = value => value.toString(16).padStart(8, '0')
const newcEntry = ({ bytes, mode, name }) => {
  const nameBytes = Buffer.from(`${name}\0`)
  const header = Buffer.from([
    '070701',
    hex(1),
    hex(mode),
    hex(0),
    hex(0),
    hex(1),
    hex(0),
    hex(bytes.length),
    hex(0),
    hex(0),
    hex(0),
    hex(0),
    hex(nameBytes.length),
    hex(0)
  ].join(''))
  const namePadding = Buffer.alloc(align4(header.length + nameBytes.length) - header.length - nameBytes.length)
  const dataPadding = Buffer.alloc(align4(bytes.length) - bytes.length)
  return Buffer.concat([header, nameBytes, namePadding, bytes, dataPadding])
}
const binary = readFileSync(binaryPath)
const client = readFileSync(clientPath)
const selftest = selftestOption == null ? undefined : readFileSync(selftestPath)
if (
  binary.length < 20 || binary.subarray(0, 4).toString('hex') !== '7f454c46' ||
  binary[4] !== 1 || binary[5] !== 1 || binary.readUInt16LE(18) !== 3
) throw new Error('Supervisor compiler did not produce a Linux i686 ELF')
const initrd = Buffer.concat([
  newcEntry({ bytes: Buffer.alloc(0), mode: 0o040755, name: 'etc' }),
  newcEntry({ bytes: Buffer.alloc(0), mode: 0o040755, name: 'sbin' }),
  newcEntry({ bytes: Buffer.alloc(0), mode: 0o040755, name: 'usr' }),
  newcEntry({ bytes: Buffer.alloc(0), mode: 0o040755, name: 'usr/bin' }),
  newcEntry({ bytes: binary, mode: 0o100755, name: 'sbin/holo-uvd' }),
  ...(selftest == null
    ? []
    : [newcEntry({ bytes: selftest, mode: 0o100755, name: 'usr/bin/holo-v86-selftest' })]),
  newcEntry({ bytes: Buffer.alloc(0), mode: 0, name: 'TRAILER!!!' })
])
writeFileSync(initrdPath, initrd)

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
process.stdout.write(`${
  JSON.stringify({
    binary: { path: binaryPath, sha256: sha256(binary), size: binary.length },
    client: { path: clientPath, sha256: sha256(client), size: client.length },
    initrd: { path: initrdPath, sha256: sha256(initrd), size: initrd.length },
    ...(selftest == null
      ? {}
      : { selftest: { path: selftestPath, sha256: sha256(selftest), size: selftest.length } }),
    target: 'x86-linux-musl',
    zigVersion: '0.16.0'
  })
}\n`)
