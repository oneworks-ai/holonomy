/* eslint-disable test/no-import-node-test -- Native CLI journey driver; Guest assertions live in conformance. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
const workload = new URL('../../../conformance/capabilities/observer-profile-native.test.mjs', import.meta.url)
const privateConfig = 'PRIVATE_DIAGNOSTIC_CONFIG_SENTINEL'
const hostContext = 'PRIVATE_HOST_CONTEXT_SENTINEL'
const privateSource = 'PRIVATE_DIAGNOSTIC_MODULE_SENTINEL'
const sha = value => createHash('sha256').update(value).digest('hex')
const moduleSource = [
  'let retainedSink;',
  "const secret = 'PRIVATE_DIAGNOSTIC_MODULE_SENTINEL';",
  'export default (event, config, sink) => {',
  "  if (event.event !== 'script.compiled' || !event.payload.origin.endsWith('/workload.test.mjs')) return;",
  '  void secret;',
  "  if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof fetch !== 'undefined')",
  "    throw Error('Unexpected ambient capability');",
  "  let denied = false; try { new Function('return 42') } catch { denied = true }",
  "  if (!denied) throw Error('Code generation was not denied');",
  "  if (typeof WebAssembly !== 'undefined') {",
  '    let blocked = false; try { new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0])) } catch { blocked = true }',
  "    if (!blocked) throw Error('Diagnostic Wasm was not denied');",
  '  }',
  '  if (retainedSink) {',
  '    let stale = false; try { retainedSink.publish() } catch { stale = true }',
  "    if (!stale) throw Error('Stale callback sink remained open');",
  '  }',
  '  retainedSink = sink;',
  "  if (config.mode === 'loop') { for (;;) {} }",
  "  if (config.mode === 'pending') return new Promise(() => {});",
  "  if (config.mode === 'throw') throw Error(config.private);",
  "  if (config.mode === 'publish-args') return sink.publish(config.private);",
  '  sink.publish();',
  '};'
].join('\n')

const profile = (id, mode) => ({
  config: { mode, private: privateConfig },
  id,
  registration: {
    acceptHighCost: true,
    callbackTimeoutMs: 1000,
    events: ['script.compiled'],
    maxQueuedEvents: 16
  },
  sink: { maxBytes: 1024 * 1024, path: `./private/${id}.jsonl` },
  use: './diagnostic.mjs'
})
const fixture = async profiles => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-profile-public-')))
  try {
    await mkdir(join(root, 'private'), { mode: 0o700 })
    await mkdir(join(root, 'data'), { mode: 0o700 })
    await writeFile(join(root, 'workload.test.mjs'), await readFile(workload))
    await writeFile(join(root, 'diagnostic.mjs'), moduleSource)
    await writeFile(join(root, 'data', 'payload.txt'), 'public-workload-data')
    await writeFile(
      join(root, 'gate.mjs'),
      'export default ctx => { ctx.holo.engineGate(request => request.operation === "runtime.code.generate.strings" && ' +
        `request.sourceSha256 === "${
          sha('40+2')
        }" ? {action:"allow"} : {action:"deny",reasonCode:"test.not_approved"}); };`
    )
    const configuration = {
      context: { host: { tenantId: hostContext }, schemaVersion: 1 },
      filesystemRoots: [{ hostPath: './data', rootId: 'workspace' }],
      observerProfiles: profiles,
      plugins: [{ id: 'gate', use: './gate.mjs' }],
      sandboxPolicy: {
        codeGeneration: {
          dynamicImport: { access: 'none' },
          strings: { access: 'controlled', decisionTimeoutMs: 500, maxOperations: 32, maxSourceBytes: 1024 },
          wasm: { access: 'none' }
        },
        diagnostics: {
          maxObserverCallbackMs: 1000,
          maxQueuedEvents: 32,
          maxSourceReadBytes: 0,
          observerEvents: ['script.compiled'],
          retentionMs: 0,
          sourceReader: 'none'
        },
        filesystem: {
          access: 'sandboxed',
          limits: {
            maxDirectoryEntries: 16,
            maxOpenHandles: 4,
            maxQueuedEvents: 0,
            maxReadBytes: 4096,
            maxWatchers: 0,
            maxWriteBytes: 1
          },
          roots: [{ rights: ['read'], rootId: 'workspace', symlinks: 'deny', virtualUrl: 'holo-fs://workspace/' }]
        },
        schemaVersion: 2
      },
      schemaVersion: 1
    }
    await writeFile(join(root, 'host.json'), JSON.stringify(configuration), { mode: 0o600 })
    return { configuration, root }
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    throw error
  }
}
const start = (f, entry = './workload.test.mjs', command = 'test') => {
  const child = spawn(binary, [command, '--timeout', '15000', '--host-config', './host.json', entry], {
    cwd: f.root,
    env: { PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const run = { child, ended: false, stderr: '', stdout: '' }
  child.stdout.on('data', bytes => run.stdout += bytes)
  child.stderr.on('data', bytes => run.stderr += bytes)
  run.done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      run.ended = true
      resolve({ code, signal, stderr: run.stderr, stdout: run.stdout })
    })
  })
  void run.done.catch(() => undefined)
  return run
}
const rows = async (f, id) => {
  let text
  try {
    text = await readFile(join(f.root, 'private', `${id}.jsonl`), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const lines = text.split('\n')
  lines.pop() // A concurrent append may leave one not-yet-complete tail.
  return lines.filter(Boolean).map(line => JSON.parse(line))
}
const until = async (run, read, accepts, name) => {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) {
    const value = await read()
    if (accepts(value)) return value
    if (run.ended) assert.fail(`${name}: Runtime ended early\n${run.stdout}\n${run.stderr}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`${name}: did not settle\n${run.stdout}\n${run.stderr}`)
}
const close = async run => {
  if (run == null || run.ended) return
  run.child.kill('SIGTERM')
  await Promise.race([run.done, new Promise(resolve => setTimeout(resolve, 1500))])
  if (!run.ended) run.child.kill('SIGKILL')
  await run.done
}
const privateFree = value => {
  const text = JSON.stringify(value)
  for (const marker of [privateConfig, privateSource, hostContext]) assert(!text.includes(marker), text)
}
const completeWorkload = async (f, run) => {
  await writeFile(join(f.root, 'data', 'gate.txt'), 'go')
  await until(
    run,
    async () => run.stdout,
    text => text.includes('OBSERVER_PROFILE_GATE_PROGRESS'),
    'Host Gate progress'
  )
  await writeFile(join(f.root, 'data', 'finish.txt'), 'go')
  const result = await run.done
  assert.equal(result.signal, null, JSON.stringify(result))
  assert.equal(result.code, 0, JSON.stringify(result))
  assert(result.stdout.includes('OBSERVER_PROFILE_GATE_PROGRESS'), result.stdout)
  privateFree(result)
}

test('Native isolated profile emits only original metadata and runs real Guest JS', {
  skip: process.platform !== 'darwin',
  timeout: 30000
}, async () => {
  const f = await fixture([profile('monitor', 'normal')])
  let run
  try {
    run = start(f)
    const records = await until(
      run,
      () => rows(f, 'monitor'),
      entries => entries.some(row => row.status === 'event'),
      'real diagnostic output'
    )
    const event = records.find(row => row.status === 'event').sourceEvent
    assert.equal(event.event, 'script.compiled')
    assert.equal(event.payload.sourceSha256, sha(await readFile(workload)))
    assert.equal(event.payload.origin, 'app://workspace/workload.test.mjs')
    assert.equal((await stat(join(f.root, 'private', 'monitor.jsonl'))).mode & 0o777, 0o600)
    await completeWorkload(f, run)
    privateFree(await rows(f, 'monitor'))
  } finally {
    await close(run)
    await rm(f.root, { force: true, recursive: true })
  }
})

test('synchronous diagnostic loop does not starve another profile or Guest Host capabilities', {
  skip: process.platform !== 'darwin',
  timeout: 30000
}, async () => {
  const f = await fixture([profile('slow', 'loop'), profile('healthy', 'normal')])
  let run
  try {
    run = start(f)
    await until(
      run,
      () => rows(f, 'slow'),
      entries => entries.some(row => row.status === 'callback.started'),
      'actual child callback start acknowledgement'
    )
    await until(
      run,
      () => rows(f, 'healthy'),
      entries => entries.some(row => row.status === 'event'),
      'independent profile progress'
    )
    await writeFile(join(f.root, 'data', 'gate.txt'), 'go')
    await until(
      run,
      async () => run.stdout,
      text => text.includes('OBSERVER_PROFILE_GATE_PROGRESS'),
      'Guest Gate progress'
    )
    await until(
      run,
      () => rows(f, 'slow'),
      entries => entries.some(row => row.status === 'callback.timeout'),
      'native diagnostic timeout'
    )
    await writeFile(join(f.root, 'data', 'finish.txt'), 'go')
    const result = await run.done
    assert.equal(result.code, 0, JSON.stringify(result))
    privateFree(result)
    privateFree(await rows(f, 'slow'))
  } finally {
    await close(run)
    await rm(f.root, { force: true, recursive: true })
  }
})

test('bad registration, unsafe sink and a private source alias fail before Guest entry', {
  skip: process.platform !== 'darwin',
  timeout: 30000
}, async () => {
  for (const mode of ['permission', 'sink', 'alias']) {
    const f = await fixture([profile('monitor', 'normal')])
    let run
    try {
      let entry = './never.mjs'
      await writeFile(join(f.root, 'never.mjs'), "console.log('PROFILE_GUEST_MUST_NOT_RUN')")
      if (mode === 'permission') f.configuration.sandboxPolicy.diagnostics.observerEvents = []
      if (mode === 'sink') await chmod(join(f.root, 'private'), 0o755)
      if (mode === 'alias') {
        await link(join(f.root, 'diagnostic.mjs'), join(f.root, 'alias.mjs'))
        await writeFile(join(f.root, 'steal.mjs'), "import './alias.mjs';console.log('PROFILE_GUEST_MUST_NOT_RUN')")
        entry = './steal.mjs'
      }
      await writeFile(join(f.root, 'host.json'), JSON.stringify(f.configuration), { mode: 0o600 })
      run = start(f, entry, 'run')
      const result = await run.done
      assert.notEqual(result.code, 0, JSON.stringify(result))
      assert(!result.stdout.includes('PROFILE_GUEST_MUST_NOT_RUN'), result.stdout)
      privateFree(result)
    } finally {
      await close(run)
      await rm(f.root, { force: true, recursive: true })
    }
  }
})
