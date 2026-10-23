// External fixture ownership only; public Runtime assertions belong in Guest JS.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { observeNativeFixtureChildClose, stopNativeFixtureChildren, waitNativeFixture } from './v86_public_child.mjs'

export const NATIVE_V86_PUBLIC_PINS = Object.freeze({
  'seabios.bin': '73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98',
  'kernel.bin': 'ca4d39b3035d6ba733416c82a44c8d636f3f544a13fea775a11583f482d16c78',
  'agent.cpio': '14079ff3d8c1d0dcd6801b60c7acc0cabea0e6572d718877a31e1393e3f80514',
  'v86.wasm': '8a969d64cf8f64b8183fdcc3a2ccdb31ae5ae6db7c9fba49949106f574640a7b'
})

const artifact = name => ({ artifactId: name, sha256: NATIVE_V86_PUBLIC_PINS[name] })
const filename = name => typeof name === 'string' && /^[a-z\d][\w.-]{0,127}$/iu.test(name)

export const createNativeV86PublicFixture = async ({
  testContext,
  prefix = 'holo-v86-public-',
  executables,
  domains = [],
  hostConfig,
  requiredKernelCapabilities = ['process']
}) => {
  assert.equal(process.platform, 'darwin', 'The explicit Native v86 profile currently requires macOS')
  assert(hostConfig?.sandboxPolicy?.process, 'The caller must explicitly provide Process Policy')
  const assets = process.env.HOLO_V86_PRODUCTION_ASSET_ROOT
  assert(assets, 'Set HOLO_V86_PRODUCTION_ASSET_ROOT to the pinned production agent assets')
  for (const [name, digest] of Object.entries(NATIVE_V86_PUBLIC_PINS)) {
    assert.equal(createHash('sha256').update(await readFile(join(assets, name))).digest('hex'), digest, name)
  }
  const binary = process.env.HOLONOMY_NATIVE_TEST_EXECUTABLE ??
    fileURLToPath(new URL('../../../target/debug/holo', import.meta.url))
  const engine = spawnSync(binary, ['engine', 'info', '--json'], {
    env: { PATH: '' },
    encoding: 'utf8',
    timeout: 5000
  })
  assert.equal(engine.status, 0, engine.stderr)
  assert.equal(JSON.parse(engine.stdout).v86BackendCompiled, true, 'Build the explicit v86-backend feature first')
  assert(/^[a-z\d-]{1,64}$/iu.test(prefix))
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  const children = new Map()
  let disposed = false
  let cleanupUnconfirmed = false
  const stop = async entries => {
    try {
      await stopNativeFixtureChildren(entries)
    } catch (error) {
      cleanupUnconfirmed = true
      throw error
    }
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await stop([...children])
    assert(!cleanupUnconfirmed, 'Native Runtime cleanup was not confirmed; fixture retained')
    await rm(root, { recursive: true, force: true })
  }
  testContext.after(dispose)
  const write = async (name, content) => {
    assert(!disposed && filename(name), 'Only fixture-owned flat filenames are accepted')
    await writeFile(join(root, name), content, { mode: 0o600, flag: 'wx' })
  }
  await write('host.json', JSON.stringify({ ...hostConfig, schemaVersion: 1, processProfileId: 'linux' }))
  await write(
    'profiles.json',
    JSON.stringify({
      schemaVersion: 1,
      profiles: {
        linux: {
          profile: 'process-profile-v1',
          backend: {
            backendId: 'experimental.v86-v1',
            configuration: {
              artifacts: {
                bios: artifact('seabios.bin'),
                kernel: artifact('kernel.bin'),
                initrd: artifact('agent.cpio'),
                wasm: artifact('v86.wasm')
              },
              memoryBytes: 134217728,
              requiredKernelCapabilities,
              supervisor: { protocolVersion: 1, execGateTimeoutMs: 30_000 }
            }
          },
          environment: { allowedScopes: ['processTree'], defaultScope: 'processTree', capabilityBridge: { domains } },
          executables: executables.map(({ executableId, path }) => ({
            executableId,
            executable: { kind: 'guestPath', path },
            fixedArgs: [],
            shell: false
          }))
        }
      }
    })
  )
  await write(
    'backends.json',
    JSON.stringify({
      schemaVersion: 1,
      backends: { 'experimental.v86-v1': { implementation: 'builtin.v86-v1', artifactRoot: await realpath(assets) } }
    })
  )
  const run = async (entry, { timeoutMs = 110_000 } = {}) => {
    assert(!disposed && filename(entry))
    assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000)
    const child = spawn(binary, [
      'test',
      '--timeout',
      String(timeoutMs),
      '--host-config',
      'host.json',
      '--process-profiles',
      'profiles.json',
      '--process-backends',
      'backends.json',
      '--experimental-v86-process',
      entry
    ], { cwd: root, env: { PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let overflow = false
    const capture = (stream, append) => {
      stream.setEncoding('utf8')
      stream.on('data', text => {
        bytes += Buffer.byteLength(text)
        if (bytes <= 256 * 1024) append(text)
        else {
          overflow = true
          child.kill('SIGTERM')
        }
      })
    }
    capture(child.stdout, text => stdout += text)
    capture(child.stderr, text => stderr += text)
    const observed = observeNativeFixtureChildClose(child)
    children.set(child, observed.closed)
    try {
      const [code, signal] = await waitNativeFixture(observed.closed, timeoutMs + 3000)
      if (observed.error != null) throw observed.error
      assert(!overflow, 'Native fixture output exceeded its bounded evidence buffer')
      return { code, signal, stdout, stderr }
    } finally {
      if (!observed.didClose && child.pid != null) await stop([[child, observed.closed]])
      children.delete(child)
    }
  }
  return Object.freeze({ root, assets, binary, write, run, dispose })
}
