/* eslint-disable test/no-import-node-test -- Host fixture; capability assertions run in Guest JS. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createSustainedHttpFixture, sustainedDuration, verifyRuntimeStopped } from './sustained_native_fixture.mjs'

const executable = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE == null
  ? undefined
  : realpathSync(process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE)
const guestSource = fileURLToPath(
  new URL('../../../conformance/capabilities/native-sustained-workload.mjs', import.meta.url)
)
const soakMs = sustainedDuration(process.env.HOLONOMY_NATIVE_SOAK_MS)
const token = randomUUID()

const policy = origin => ({
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
      maxReadBytes: 256,
      maxWriteBytes: 256,
      maxOpenHandles: 2,
      maxDirectoryEntries: 8,
      maxWatchers: 0,
      maxQueuedEvents: 0
    }
  },
  network: {
    access: 'restricted',
    allowedOrigins: [origin],
    allowedSchemes: ['http'],
    allowPrivateNetwork: true,
    limits: {
      maxChunkBytes: 256,
      maxConcurrentConnections: 1,
      maxHeaderBytes: 4096,
      maxHeaders: 32,
      maxRedirects: 0,
      maxRequestBodyBytes: 256,
      maxResponseBodyBytes: 256,
      maxUrlBytes: 512,
      socketTimeoutMs: 5000
    },
    requestBodyInspection: { access: 'none' }
  }
})

const processRows = () => {
  const result = spawnSync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,rss=,comm='], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+/u.exec(line)
    return match == null ? null : {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      command: line.slice(match[0].length)
    }
  }).filter(Boolean)
}

const sampleOwnedRuntime = (cliPid, expectedPid, rounds) => {
  const selectedName = basename(executable)
  const children = processRows().filter(row =>
    row.ppid === cliPid && (row.command === selectedName || row.command.endsWith(`/${selectedName}`))
  )
  assert.equal(children.length, 1, `expected one owned Native Runtime at round ${rounds}: ${JSON.stringify(children)}`)
  const runtime = children[0]
  if (expectedPid != null) assert.equal(runtime.pid, expectedPid, 'Native Runtime identity changed during soak')
  const listed = spawnSync('/usr/sbin/lsof', ['-nP', '-p', String(runtime.pid), '-F', 'f'], {
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024
  })
  const fds = listed.status === 0 ? listed.stdout.split('\n').filter(line => /^f\d+$/u.test(line)).length : null
  return { rounds, pid: runtime.pid, rssKiB: runtime.rssKiB, fds, observedAt: new Date().toISOString() }
}

test('one Native Runtime sustains FS callbacks/handles, Crypto and local HTTP across plugin revisions', {
  timeout: soakMs + 55_000
}, async t => {
  assert.equal(process.platform, 'darwin')
  assert.ok(executable, 'HOLONOMY_NATIVE_TEST_EXECUTABLE must select the exact Native binary')
  const root = await mkdtemp(join(tmpdir(), 'holo-native-sustained-'))
  const configPath = join(root, 'host.json')
  const pluginRoot = join(root, 'plugins', 'soak')
  let http
  let child
  let closed = false
  let closeResult
  let primaryError
  let cleanupError
  const lines = []
  const samples = []
  const waiters = new Set()
  let rounds = 0
  let pass
  let activeRevision = 1
  let rejected = 0
  let runtimePid
  let sampleError
  let streamFailure
  const notify = () => {
    for (const check of [...waiters]) check()
  }
  const failStream = (stream, error) => {
    streamFailure ??= new Error(`Native ${stream} output handling failed`, { cause: error })
    notify()
  }
  const waitFor = (predicate, label, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      let timer
      const check = () => {
        try {
          if (streamFailure != null) throw streamFailure
          if (predicate()) {
            clearTimeout(timer)
            waiters.delete(check)
            resolve()
          } else if (closed) {
            throw new Error(`${label}: Native CLI closed early ${JSON.stringify(closeResult)}`)
          }
        } catch (error) {
          clearTimeout(timer)
          waiters.delete(check)
          reject(error)
        }
      }
      timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`${label}: timed out after ${timeoutMs} ms; last lines ${JSON.stringify(lines.slice(-10))}`))
      }, timeoutMs)
      waiters.add(check)
      check()
    })
  const record = (stream, line) => {
    try {
      lines.push({ stream, line })
      if (line.startsWith('NATIVE_SOAK_PROGRESS:')) {
        const progress = JSON.parse(line.slice('NATIVE_SOAK_PROGRESS:'.length))
        assert.equal(progress.fsCallback, progress.rounds)
        assert.equal(progress.fsPromise, progress.rounds)
        assert.equal(progress.crypto, progress.rounds)
        assert.equal(progress.http, progress.rounds)
        rounds = progress.rounds
        if (rounds === 1 || rounds % 20 === 0) {
          try {
            const sample = sampleOwnedRuntime(child.pid, runtimePid, rounds)
            runtimePid = sample.pid
            samples.push(sample)
            process.stdout.write(`NATIVE_SOAK_SAMPLE ${JSON.stringify(sample)}\n`)
          } catch (error) {
            sampleError = error
            throw error
          }
        }
      }
      if (line.startsWith('NATIVE_SOAK_PASS:')) pass = JSON.parse(line.slice('NATIVE_SOAK_PASS:'.length))
      const match = /plugin graph revision (\d+) active/u.exec(line)
      if (match) activeRevision = Number(match[1])
      if (line.includes('plugin update rejected')) rejected += 1
      if (
        line.startsWith('NATIVE_SOAK_PASS:') || line.includes('plugin graph revision') ||
        line.includes('plugin update rejected')
      ) {
        process.stdout.write(`NATIVE_SOAK_EVENT ${stream} ${line}\n`)
      }
      notify()
    } catch (error) {
      failStream(stream, error)
    }
  }
  const writeConfig = async config => {
    const staged = `${configPath}.${token}.next`
    await writeFile(staged, JSON.stringify(config), { mode: 0o600 })
    await rename(staged, configPath)
  }
  try {
    await mkdir(join(root, 'data'))
    await mkdir(pluginRoot, { recursive: true })
    await copyFile(guestSource, join(root, 'index.js'))
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await writeFile(
      join(pluginRoot, 'package.json'),
      JSON.stringify({
        type: 'module',
        holo: { kind: 'runtime-plugin', apiVersion: 1, entry: './index.mjs', configSchema: './schema.json' }
      })
    )
    await writeFile(join(pluginRoot, 'index.mjs'), 'export default function noop() {}\n')
    await writeFile(
      join(pluginRoot, 'schema.json'),
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties: { revision: { type: 'integer' } },
        required: ['revision']
      })
    )
    http = await createSustainedHttpFixture()
    const config = {
      schemaVersion: 1,
      filesystemRoots: [{ rootId: 'workspace', hostPath: './data' }],
      sandboxPolicy: policy(http.origin),
      plugins: [{ id: 'soak', use: './plugins/soak', config: { revision: 1 } }]
    }
    await writeConfig(config)
    const startedAt = performance.now()
    child = spawn(executable, [
      'run',
      '--watch',
      '--timeout',
      String(soakMs + 40_000),
      '--host-config',
      'host.json',
      './index.js',
      http.origin,
      String(soakMs)
    ], {
      cwd: root,
      env: { PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.once('close', (code, signal) => {
      closed = true
      closeResult = { code, signal, elapsedMs: performance.now() - startedAt, closedAt: new Date().toISOString() }
      notify()
    })
    child.once('error', error => {
      primaryError ??= error
      failStream('process', error)
    })
    for (const stream of ['stdout', 'stderr']) {
      const reader = createInterface({ input: child[stream] })
      reader.on('line', line => record(stream, line))
      reader.on('error', error => failStream(stream, error))
      child[stream].on('error', error => failStream(stream, error))
    }
    await waitFor(
      () => lines.some(item => item.line.includes('plugin watch ready')) && rounds > 0,
      'Native Guest work and watch ready'
    )
    for (let step = 1; step <= 28; step += 1) {
      await waitFor(() => rounds >= step * 5, `five capability rounds before candidate ${step}`, 20_000)
      const invalid = step % 7 === 0
      const oldRejected = rejected
      config.plugins[0].config.revision = invalid ? 'invalid-schema' : step + 1
      await writeConfig(config)
      if (invalid) {
        await waitFor(() => rejected > oldRejected, `rejected candidate ${step}`)
      } else {
        await waitFor(() => activeRevision === step + 1 - Math.floor(step / 7), `active candidate ${step}`)
      }
      assert.equal(closed, false, `candidate ${step} lost the Native Runtime`)
    }
    await waitFor(() => pass != null, 'Guest sustained completion', Math.max(70_000, soakMs - 120_000))
    await waitFor(() => closed, 'Native CLI natural close after Guest completion', 12_000)
    const result = closeResult
    assert.equal(primaryError, undefined, String(primaryError))
    assert.equal(sampleError, undefined, String(sampleError))
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null })
    assert.ok(result.elapsedMs >= soakMs, `Native CLI lived ${result.elapsedMs} ms`)
    assert.ok(pass.elapsedMs >= soakMs, JSON.stringify(pass))
    assert.ok(pass.rounds >= 140, JSON.stringify(pass))
    assert.equal(http.requests(), pass.rounds, 'each Guest round reached the real loopback server')
    assert.equal(activeRevision, 25, '24 valid plugin graph replacements were published')
    assert.equal(rejected, 4, 'four invalid candidates were rejected in the same Runtime')
    assert.ok(samples.length >= 7, JSON.stringify(samples))
    assert.ok(samples.every(sample => sample.pid === runtimePid), 'one Native Runtime PID owned every sample')
    assert.ok(
      Date.parse(result.closedAt) - Date.parse(samples[0].observedAt) >= soakMs - 5_000,
      'the observed Native Runtime PID must span the selected workload (less startup) until its natural close'
    )
    assert.equal(await readFile(join(root, 'data', 'callback.txt'), 'utf8'), `native-soak-${pass.rounds - 1}`)
    assert.equal(await readFile(join(root, 'data', 'promise.txt'), 'utf8'), `native-soak-${pass.rounds - 1}`)
    const evidence = {
      cliPid: child.pid,
      runtimePid,
      binary: executable,
      result,
      pass,
      activeRevision,
      rejected,
      httpRequests: http.requests(),
      samples
    }
    t.diagnostic(JSON.stringify(evidence))
    process.stdout.write(`NATIVE_SOAK_EVIDENCE ${JSON.stringify(evidence)}\n`)
  } catch (error) {
    primaryError ??= error
  } finally {
    if (child != null && !closed) {
      const waitForOwnedClose = durationMs =>
        new Promise(resolve => {
          if (closed) return resolve(true)
          let timer
          const onClose = () => {
            clearTimeout(timer)
            resolve(true)
          }
          timer = setTimeout(() => {
            child.removeListener('close', onClose)
            resolve(false)
          }, durationMs)
          child.once('close', onClose)
        })
      child.kill('SIGTERM')
      if (!await waitForOwnedClose(8_000)) {
        child.kill('SIGKILL')
        if (!await waitForOwnedClose(8_000)) {
          cleanupError = new Error('Owned Native CLI close was not confirmed after SIGKILL')
          process.stderr.write(`NATIVE_SOAK_CLEANUP_FAILURE ${cleanupError.message}\n`)
        }
      }
    }
    if (http != null) {
      try {
        await http.close()
      } catch (error) {
        cleanupError = error
      }
    }
    try {
      await verifyRuntimeStopped(runtimePid, pid => processRows().some(row => row.pid === pid))
    } catch (error) {
      cleanupError = error
    }
    if (closed && primaryError == null && cleanupError == null) await rm(root, { recursive: true, force: true })
    else process.stderr.write(`NATIVE_SOAK_FIXTURE_RETAINED ${root}\n`)
  }
  if (primaryError != null && cleanupError != null) {
    throw new AggregateError([primaryError, cleanupError], 'Native run and cleanup both failed')
  }
  if (primaryError != null) throw primaryError
  if (cleanupError != null) throw cleanupError
})
