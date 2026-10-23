/* eslint-disable test/no-import-node-test -- Native driver; public API assertions execute in Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workload = new URL('../../../conformance/capabilities/filesystem-lstat-native.test.mjs', import.meta.url)
const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))

test('standalone Native lstat supports bounded withinRoot objects and retains deny behavior', async t => {
  for (const withinRoot of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'holo-native-lstat-'))
    try {
      const data = join(root, 'data')
      await mkdir(join(data, 'real'), { recursive: true })
      await writeFile(join(data, 'real/file'), 'ORIGINAL')
      await writeFile(join(root, 'outside'), 'OUTSIDE_SENTINEL')
      await symlink('real', join(data, 'alias'))
      await symlink('real/file', join(data, 'file-link'))
      await symlink('real', join(data, 'dir-link'))
      await symlink('../outside', join(data, 'external-link'))
      await symlink('missing', join(data, 'broken-link'))
      await writeFile(join(root, 'workload.mjs'), await readFile(workload))
      await writeFile(
        join(root, 'lstat.test.mjs'),
        `import { registerFilesystemLstatTests } from './workload.mjs';
         registerFilesystemLstatTests({withinRoot:${withinRoot}});`
      )
      const config = join(root, 'host.json')
      await writeFile(
        config,
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
                symlinks: withinRoot ? 'withinRoot' : 'deny',
                rights: ['read', 'list']
              }],
              limits: {
                maxReadBytes: 4096,
                maxWriteBytes: 1,
                maxOpenHandles: 4,
                maxDirectoryEntries: 16,
                maxQueuedEvents: 0,
                maxWatchers: 0
              }
            }
          }
        }),
        { mode: 0o600 }
      )
      const result = spawnSync(binary, [
        'test',
        '--timeout',
        '10000',
        '--host-config',
        config,
        join(root, 'lstat.test.mjs')
      ], { encoding: 'utf8', env: { PATH: '' }, timeout: 15000 })
      assert.equal(result.error, undefined, result.error?.message)
      t.diagnostic(JSON.stringify({ withinRoot, stdout: result.stdout, stderr: result.stderr }))
      assert.equal(result.status, 0, result.stdout + result.stderr)
      const report = result.stdout.split('\n').map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).find(value => Array.isArray(value?.results))
      assert.equal(report?.passed, 6, result.stdout + result.stderr)
      assert.equal(report.failed, 0)
      assert.equal(report.skipped, 0)
      assert.equal(await readFile(join(data, 'real/file'), 'utf8'), 'ORIGINAL')
      assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'OUTSIDE_SENTINEL')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
