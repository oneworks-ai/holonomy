/* eslint-disable test/no-import-node-test -- Native driver; assertions execute as shared Guest JS. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createProcessListenerPolicy,
  createProcessListenerProfile
} from '../../test-support/process-listener-profile.mjs'

test('standalone Rust/V8 runs the shared listener workload with Node-compatible local removal', {
  skip: process.platform !== 'darwin'
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-listeners-'))
  try {
    await writeFile(
      join(root, 'listeners.mjs'),
      await readFile(
        new URL('../../../conformance/capabilities/process-listeners.test.mjs', import.meta.url)
      )
    )
    await writeFile(
      join(root, 'entry.test.mjs'),
      [
        "import { registerNativeProcessListenerTests } from './listeners.mjs';",
        "registerNativeProcessListenerTests({ executableId: 'echo', args: ['LISTENER_PAYLOAD'] });"
      ].join('\n')
    )
    await writeFile(
      join(root, 'host.json'),
      JSON.stringify({
        schemaVersion: 1,
        processProfileId: 'listeners',
        sandboxPolicy: { schemaVersion: 2, process: createProcessListenerPolicy() }
      }),
      { mode: 0o600 }
    )
    await writeFile(
      join(root, 'profiles.json'),
      JSON.stringify({
        schemaVersion: 1,
        profiles: { listeners: createProcessListenerProfile() }
      }),
      { mode: 0o600 }
    )
    const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
      fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
    const result = spawnSync(binary, [
      'test',
      '--timeout',
      '10000',
      '--host-config',
      join(root, 'host.json'),
      '--process-profiles',
      join(root, 'profiles.json'),
      join(root, 'entry.test.mjs')
    ], { cwd: root, env: { PATH: '' }, encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.error, undefined, result.error?.message)
    t.diagnostic(result.stdout)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const summary = result.stdout.split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    }).find(item => item.passed === 1)
    assert(summary, result.stdout)
    assert.equal(summary.failed, 0)
    assert.equal(summary.skipped, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
