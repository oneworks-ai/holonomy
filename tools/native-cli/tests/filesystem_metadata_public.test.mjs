/* eslint-disable test/no-import-node-test -- External fixture; API assertions execute in Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workload = fileURLToPath(
  new URL('../../../conformance/capabilities/filesystem-metadata-native.test.mjs', import.meta.url)
)
const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))

test('standalone Rust/V8 runs the public metadata and durability Guest contract without Node', async t => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-fs-metadata-'))
  try {
    const data = join(root, 'data')
    await mkdir(data)
    for (
      const [name, contents] of [
        ['times.txt', 'PRESERVED'],
        ['handle.txt', 'HANDLE_CONTENT'],
        ['sync.txt', 'SYNC_CONTENT'],
        ['callback.txt', 'CALLBACK'],
        ['readonly.txt', 'READ_ONLY'],
        ['bounded.txt', 'KEEP_BOUNDED']
      ]
    ) await writeFile(join(data, name), contents)
    for (const [name, mode] of [['write-only-time.txt', 0o200], ['read-only-time.txt', 0o400]]) {
      await writeFile(join(data, name), 'UNCHANGED')
      await chmod(join(data, name), mode)
    }
    const hostConfig = join(root, 'host.json')
    await writeFile(
      hostConfig,
      JSON.stringify({
        schemaVersion: 1,
        filesystemRoots: [{ rootId: 'workspace', hostPath: './data' }],
        sandboxPolicy: {
          schemaVersion: 2,
          filesystem: {
            access: 'sandboxed',
            roots: [{
              rootId: 'workspace',
              virtualUrl: 'holo-fs://workspace/',
              symlinks: 'deny',
              rights: ['read', 'write', 'create', 'list']
            }],
            limits: {
              maxReadBytes: 4096,
              maxWriteBytes: 4096,
              maxOpenHandles: 8,
              maxDirectoryEntries: 32,
              maxQueuedEvents: 0,
              maxWatchers: 0
            }
          }
        }
      }),
      { mode: 0o600 }
    )
    const result = spawnSync(binary, ['test', '--timeout', '10000', '--host-config', hostConfig, workload], {
      encoding: 'utf8',
      env: { PATH: '' },
      timeout: 15000
    })
    assert.equal(result.error, undefined, result.error?.message)
    const report = result.stdout.split('\n').map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    }).find(value => value?.results != null)
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
    assert.equal(report?.failed, 0, JSON.stringify(report))
    assert.equal(report?.passed, 9, JSON.stringify(report))
    assert.equal(report?.skipped, 0, JSON.stringify(report))
    for (const name of ['write-only-time.txt', 'read-only-time.txt']) {
      assert.equal((await stat(join(data, name))).mtimeMs, 1_234_001_500)
      await chmod(join(data, name), 0o600)
      assert.equal(await readFile(join(data, name), 'utf8'), 'UNCHANGED')
    }
    t.diagnostic(JSON.stringify({ runtime: 'standalone-rusty-v8', guestReport: report }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
