import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Host driver only owns the external fixture and terminal result.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'
import { capabilityRuntimeSession } from './capability-runtime-fixture.mjs'

test('Guest node:test validates real metadata changes and descriptor sync through the Node Runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-fs-metadata-guest-'))
  fs.writeFileSync(path.join(root, 'file'), 'PRESERVED')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(capabilityRuntimeSession({
    entryUrl: 'app+local://workspace/main.mjs',
    hostPath: root,
    moduleRootUrl: 'app+local://workspace/',
    source: `
      import { test, run } from 'node:test'
      import assert from 'node:assert/strict'
      import {
        accessSync, closeSync, constants, fdatasyncSync, fsyncSync, ftruncateSync,
        futimesSync, openSync, readFileSync, statSync, utimesSync
      } from 'node:fs'
      import { access, open, truncate, utimes } from 'node:fs/promises'
      const file = 'holo-fs://workspace/file'
      test('standard FS metadata and sync use real pinned Host objects', async () => {
        assert.equal(utimesSync(file, 1700000000.125, 1700000001.875), undefined)
        assert.equal(statSync(file).mtimeMs, 1700000001875)
        const fd = openSync(file, 'r+')
        assert.equal(fsyncSync(fd), undefined)
        assert.equal(fdatasyncSync(fd), undefined)
        futimesSync(fd, 1700000002, 1700000003)
        ftruncateSync(fd, 4)
        closeSync(fd)
        assert.equal(readFileSync(file, 'utf8'), 'PRES')
        assert.equal(await access(file, constants.R_OK), undefined)
        assert.equal(accessSync(file, constants.W_OK), undefined)
        assert.equal(await utimes(file, 1700000004, 1700000005), undefined)
        const handle = await open(file, 'r+')
        assert.equal(await handle.sync(), undefined)
        assert.equal(await handle.datasync(), undefined)
        assert.equal(await handle.utimes(1700000006, 1700000007), undefined)
        assert.equal(await handle.truncate(2), undefined)
        await handle.close()
        assert.equal(await truncate(file, 1), undefined)
        assert.equal(readFileSync(file, 'utf8'), 'P')
      })
      const summary = await run()
      console.log('FS_METADATA_GUEST:' + JSON.stringify(summary))
      if (summary.failed !== 0) throw new Error('Guest filesystem metadata test failed')
    `
  }))
  const line = logs.find(value => value.startsWith('FS_METADATA_GUEST:'))
  assert.ok(line, `Guest result missing: ${logs.join(' | ')}`)
  const summary = JSON.parse(line.slice('FS_METADATA_GUEST:'.length))
  assert.equal(summary.failed, 0)
  assert.equal(summary.passed, 1)
  assert.equal(fs.readFileSync(path.join(root, 'file'), 'utf8'), 'P')
})

test('Guest node:test chmod uses fresh Host authority and real file mode through Node Runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-fs-chmod-guest-'))
  fs.writeFileSync(path.join(root, 'file'), 'PRESERVED')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 10_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event.text))
  await supervisor.start(capabilityRuntimeSession({
    entryUrl: 'app+local://workspace/main.mjs',
    filesystemRights: ['chmod', 'read'],
    hostPath: root,
    moduleRootUrl: 'app+local://workspace/',
    source: `
      import { test, run } from 'node:test'
      import assert from 'node:assert/strict'
      import { chmod, chmodSync, closeSync, fchmodSync, openSync, statSync } from 'node:fs'
      import { chmod as chmodPromise, open } from 'node:fs/promises'
      const file = 'holo-fs://workspace/file'
      test('chmod path and readonly descriptors without data write', async () => {
        assert.equal(chmodSync(file, '0644'), undefined)
        assert.equal(statSync(file).mode & 0o777, 0o644)
        assert.equal(await chmodPromise(file, '0755'), undefined)
        assert.equal(statSync(file).mode & 0o777, 0o755)
        const fd = openSync(file, 'r')
        assert.equal(fchmodSync(fd, 0), undefined)
        assert.equal(fchmodSync(fd, '0600'), undefined)
        closeSync(fd)
        const handle = await open(file, 'r')
        assert.equal(await handle.chmod('0640'), undefined)
        await handle.close()
        assert.equal(statSync(file).mode & 0o777, 0o640)
        const callback = await new Promise(resolve => chmod(file, 0o600, (...args) => resolve(args)))
        assert.equal(callback.length, 1)
        assert.equal(callback[0], null)
        const before = statSync(file).mode
        assert.throws(() => chmodSync(file, 0o4755), { code: 'EINVAL' })
        assert.throws(() => chmodSync(file, 0o100644), { code: 'EINVAL' })
        assert.equal(statSync(file).mode, before)
      })
      const summary = await run()
      console.log('FS_CHMOD_GUEST:' + JSON.stringify(summary))
      if (summary.failed !== 0) throw new Error('Guest chmod test failed')
    `
  }))
  const line = logs.find(value => value.startsWith('FS_CHMOD_GUEST:'))
  assert.ok(line, `Guest result missing: ${logs.join(' | ')}`)
  const summary = JSON.parse(line.slice('FS_CHMOD_GUEST:'.length))
  assert.equal(summary.failed, 0)
  assert.equal(summary.passed, 1)
  assert.equal(fs.statSync(path.join(root, 'file')).mode & 0o777, 0o600)
})
