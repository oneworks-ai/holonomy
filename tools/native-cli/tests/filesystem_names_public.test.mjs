/* eslint-disable test/no-import-node-test -- Native driver; public API assertions execute in Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const workload = new URL('../../../conformance/capabilities/filesystem-names-native.test.mjs', import.meta.url)
const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))

test('standalone Native interoperates with actual Host filenames under both symlink profiles', async t => {
  for (const withinRoot of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'holo-native-fs-names-'))
    try {
      const data = join(root, 'data')
      await mkdir(data)
      const names = ['a b.txt', '中文😀.txt', '%literal.txt', '%2F.txt', '.hidden', 'rename %2F.txt']
      for (const name of names) await writeFile(join(data, name), `HOST:${name}`)
      // Existing targets ensure an accidentally decoded separator cannot pass as a missing-file error.
      await mkdir(join(data, 'bad'))
      await writeFile(join(data, 'bad', 'slash'), 'SEPARATOR_SENTINEL')
      await writeFile(join(data, 'bad\\backslash'), 'BACKSLASH_SENTINEL')
      if (withinRoot) await symlink('%2F.txt', join(data, 'link 中.txt'))
      await writeFile(join(root, 'workload.mjs'), await readFile(workload))
      await writeFile(
        join(root, 'names.test.mjs'),
        `import { registerFilesystemNameTests } from './workload.mjs';
         registerFilesystemNameTests({withinRoot:${withinRoot}});`
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
                rights: ['read', 'write', 'create', 'list', 'move']
              }],
              limits: {
                maxReadBytes: 4096,
                maxWriteBytes: 4096,
                maxOpenHandles: 4,
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
        config,
        join(root, 'names.test.mjs')
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
      assert.equal(report?.passed, 10, result.stdout + result.stderr)
      assert.equal(report.failed, 0)
      assert.equal(report.skipped, 0)
      assert.equal(await readFile(join(data, 'new 中 %2F.txt'), 'utf8'), 'GUEST_WRITE')
      assert.equal(await readFile(join(data, 'bad', 'slash'), 'utf8'), 'SEPARATOR_SENTINEL')
      assert.equal(await readFile(join(data, 'bad\\backslash'), 'utf8'), 'BACKSLASH_SENTINEL')
      assert.equal((await readdir(data)).includes('new%20%E4%B8%AD%20%252F.txt'), false)
      if (!withinRoot) {
        assert.equal(await readFile(join(data, 'moved 中😀.txt'), 'utf8'), 'HOST:rename %2F.txt')
        assert.equal((await readdir(data)).includes('rename %2F.txt'), false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
