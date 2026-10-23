import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const zig = process.argv[2]
if (zig == null) throw new TypeError('Usage: node run-fuse-bridge-response.mjs <zig>')

const tests = dirname(fileURLToPath(import.meta.url))
const supervisor = resolve(tests, '..')
const output = mkdtempSync(join(tmpdir(), 'holonomy-fuse-response-'))
try {
  const binary = join(output, 'fuse-bridge-response')
  execFileSync(zig, [
    'cc',
    '-std=c11',
    '-D_GNU_SOURCE',
    '-D_DEFAULT_SOURCE',
    '-Dread=holo_test_read',
    '-Dwrite=holo_test_write',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-I',
    join(tests, 'include'),
    '-o',
    binary,
    join(supervisor, 'fuse-bridge.c'),
    join(tests, 'fuse-bridge-response.test.c')
  ], { stdio: 'inherit' })
  execFileSync(binary, [], { stdio: 'inherit' })
} finally {
  rmSync(output, { force: true, recursive: true })
}
