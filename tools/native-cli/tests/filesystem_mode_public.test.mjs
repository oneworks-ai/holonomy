/* eslint-disable test/no-import-node-test -- Fixture only; API assertions run in real Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workload = new URL('../../../conformance/capabilities/filesystem-mode-native.test.mjs', import.meta.url)
const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))

test('standalone Native chmod needs explicit authority and uses actual filesystem objects', async t => {
  for (const allowChmod of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'holo-mode-public-'))
    try {
      const data = join(root, 'data')
      await mkdir(join(data, 'directory'), { recursive: true })
      for (
        const name of [
          'denied.txt',
          'host-denied.txt',
          'promise.txt',
          'sync-fd.txt',
          'callback.txt',
          'restore.txt',
          'invalid.txt',
          'executable.txt',
          'bound.txt'
        ]
      ) {
        await writeFile(join(data, name), 'UNCHANGED')
        await chmod(join(data, name), 0o640)
      }
      await writeFile(join(root, 'workload.mjs'), await readFile(workload))
      await writeFile(
        join(root, 'mode.test.mjs'),
        `import {registerFilesystemModeTests} from './workload.mjs';registerFilesystemModeTests({allowChmod:${allowChmod}});`
      )
      const host = join(root, 'host.json')
      await writeFile(
        join(root, 'host-plugin.mjs'),
        `export default ctx => {
        ctx.holo.intercept({operation:'filesystem.metadata.chmod'},(request,next)=> {
          if(request.resource.requested.pathSegments.includes('host-denied.txt')) return ctx.holo.deny(request);
          return next();
        },{execution:'sync'});
      };`
      )
      await writeFile(
        host,
        JSON.stringify({
          schemaVersion: 1,
          plugins: [{ id: 'mode-boundary', use: './host-plugin.mjs' }],
          filesystemRoots: [{ rootId: 'workspace', hostPath: './data' }],
          sandboxPolicy: {
            schemaVersion: 2,
            filesystem: {
              access: 'sandboxed',
              roots: [{
                rootId: 'workspace',
                virtualUrl: 'holo-fs://workspace/',
                symlinks: 'deny',
                rights: ['read', 'write', 'create', 'list', ...(allowChmod ? ['chmod', 'move'] : [])]
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
      const result = spawnSync(binary, [
        'test',
        '--timeout',
        '10000',
        '--host-config',
        host,
        join(root, 'mode.test.mjs')
      ], {
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
      t.diagnostic(JSON.stringify({ allowChmod, code: result.status, report }))
      assert.equal(result.status, 0, result.stderr + result.stdout)
      assert.equal(report?.passed, allowChmod ? 9 : 1, JSON.stringify(report))
      assert.equal(report?.failed, 0)
      assert.equal(report?.skipped, 0)
      assert.equal((await stat(join(data, 'denied.txt'))).mode & 0o777, 0o640)
      assert.equal((await stat(join(data, 'host-denied.txt'))).mode & 0o777, 0o640)
      if (allowChmod) {
        assert.equal((await stat(join(data, 'bound-original.txt'))).mode & 0o777, 0o644)
        assert.equal((await stat(join(data, 'bound.txt'))).mode & 0o777, 0o640)
        assert.equal(await readFile(join(data, 'bound.txt'), 'utf8'), 'REPLACEMENT')
        for (
          const [name, mode] of [
            ['promise.txt', 0o640],
            ['sync-fd.txt', 0o600],
            ['callback.txt', 0o644],
            ['restore.txt', 0o600],
            ['invalid.txt', 0o640],
            ['executable.txt', 0o755]
          ]
        ) {
          assert.equal((await stat(join(data, name))).mode & 0o777, mode, name)
          assert.equal(await readFile(join(data, name), 'utf8'), 'UNCHANGED')
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
