/* eslint-disable test/no-import-node-test -- Native orchestration only; API assertions run in Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
const workload = fileURLToPath(
  new URL(
    '../../../conformance/capabilities/filesystem-callbacks-native.test.mjs',
    import.meta.url
  )
)

test('real Native filesystem callbacks enter a local Event Loop task rather than a Promise job', async t => {
  const root = await mkdtemp(join(tmpdir(), 'holo-fs-callbacks-'))
  try {
    await mkdir(join(root, 'data'))
    await writeFile(join(root, 'data/input.txt'), 'IO\n')
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
              symlinks: 'deny',
              rights: ['read', 'write', 'create']
            }],
            limits: {
              maxReadBytes: 4096,
              maxWriteBytes: 4096,
              maxOpenHandles: 4,
              maxDirectoryEntries: 16,
              maxWatchers: 0,
              maxQueuedEvents: 0
            }
          }
        }
      }),
      { mode: 0o600 }
    )
    const run = (args, timeout = 15000) =>
      spawnSync(binary, args, {
        env: { PATH: '' },
        encoding: 'utf8',
        timeout
      })
    const result = run(['test', '--timeout', '10000', '--host-config', config, workload])
    assert.equal(result.error, undefined)
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
    assert.equal(await readFile(join(root, 'data/output.txt'), 'utf8'), 'CALLBACK_WRITE')
    t.diagnostic(JSON.stringify({ report }))

    const entry = join(root, 'callback-throw.mjs')
    await writeFile(
      entry,
      `import fs from 'node:fs';
      fs.readFile('holo-fs://workspace/input.txt', () => {
        setImmediate(() => console.log('LATE_CALLBACK_MARKER'));
        throw new Error('filesystem callback original');
      });`
    )
    const thrown = run(['--timeout', '5000', '--host-config', config, entry])
    assert.equal(thrown.error, undefined)
    assert.equal(thrown.status, 1, thrown.stdout + thrown.stderr)
    assert.equal(thrown.stdout.includes('LATE_CALLBACK_MARKER'), false)
    assert.match(thrown.stderr, /filesystem callback original/u)
    assert.match(thrown.stderr, /app:\/\/workspace\/callback-throw\.mjs/u)
    assert.equal(thrown.stderr.includes(root), false)
    t.diagnostic(JSON.stringify({ callbackThrow: thrown.stderr }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
