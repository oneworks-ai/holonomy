import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { createV86ProcessBackendV1 } from '../../../adapters/node/src/capability-process-v86-backend.mjs'

const paths = process.argv.slice(2)
if (paths.length !== 6) {
  throw new TypeError('Usage: node probe-image.mjs <libv86> <wasm> <bios> <kernel> <initrd> <base|agent>')
}
const [modulePath, wasmPath, biosPath, kernelPath, initrdPath, profile] = paths
if (!['agent', 'base'].includes(profile)) throw new TypeError('Invalid image probe profile')
const { V86: ImportedV86 } = await import(pathToFileURL(modulePath).href)
const values = new Map(
  await Promise.all(
    [['wasm', wasmPath], ['bios', biosPath], ['kernel', kernelPath], ['initrd', initrdPath]].map(
      async ([id, path]) => [id, new Uint8Array(await readFile(path))]
    )
  )
)
const artifact = artifactId => ({
  artifactId,
  sha256: createHash('sha256').update(values.get(artifactId)).digest('hex')
})
let serial = ''
class ProbeV86 extends ImportedV86 {
  constructor(options) {
    super(options)
    this.add_listener('serial0-output-byte', byte => {
      serial = (serial + String.fromCharCode(byte)).slice(-32_768)
      if (process.env.HOLO_V86_TRACE === '1') process.stderr.write(String.fromCharCode(byte))
    })
  }
}
const backend = createV86ProcessBackendV1({
  V86: ProbeV86,
  handleExecutionRequest(input) {
    if (process.env.HOLO_V86_TRACE === '1') process.stderr.write(`[exec-gate] ${JSON.stringify(input)}\n`)
    if (input.path !== '/bin/cat' || input.argv.join('\0') !== '/bin/cat') {
      throw new TypeError('Unexpected image probe descendant')
    }
  },
  loadArtifact: input => values.get(input.artifactId),
  readyTimeoutMs: 90_000
})
const configuration = backend.normalizeConfiguration({
  artifacts: {
    bios: artifact('bios'),
    initrd: artifact('initrd'),
    kernel: artifact('kernel'),
    wasm: artifact('wasm')
  },
  memoryBytes: 256 * 1024 * 1024,
  requiredKernelCapabilities: ['process'],
  supervisor: { protocolVersion: 1 }
})
const executablePaths = Object.freeze({
  cat: '/bin/cat',
  curl: '/usr/bin/curl',
  git: '/usr/bin/git',
  jq: '/usr/bin/jq',
  shell: '/bin/sh',
  ssh: '/usr/bin/ssh'
})
const launch = (executableId, path, args) =>
  backend.spawn(
    backend.prepareLaunch({
      configuration,
      environmentScope: 'processTree',
      executable: backend.normalizeExecutable({ kind: 'guestPath', path }),
      executableId,
      executables: Object.entries(executablePaths).map(([id, executablePath]) => ({
        executable: { kind: 'guestPath', path: executablePath },
        executableId: id,
        fixedArgs: [],
        shell: id === 'shell'
      })),
      generation: 1,
      policy: { access: 'sandboxed' },
      runtimeArgs: args
    }),
    { cwd: '/', env: { HOME: '/tmp', LANG: 'C', PATH: '/bin:/usr/bin' }, stdio: ['pipe', 'pipe', 'pipe'] },
    {
      processResourceId: `probe-${executableId}`
    }
  )
const execute = async (executableId, path, args) => {
  const running = launch(executableId, path, args)
  const stdout = []
  const stderr = []
  running.child.on('error', error => {
    if (process.env.HOLO_V86_TRACE === '1') {
      process.stderr.write(`[child-error] ${error.stack ?? String(error)}\n`)
    }
  })
  running.child.stdout.on('data', value => stdout.push(value))
  running.child.stderr.on('data', value => stderr.push(value))
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      running.killTree('SIGKILL')
      reject(new Error(`v86 image command timeout: ${path}`))
    }, 120_000)
  })
  const [code, signal] = await Promise.race([once(running.child, 'close'), timeout])
  clearTimeout(timer)
  return Object.freeze({
    code,
    signal,
    stderr: Buffer.concat(stderr).toString(),
    stdout: Buffer.concat(stdout).toString()
  })
}

try {
  const shell = await execute('shell', '/bin/sh', [
    '-c',
    'printf "SHELL_TO_CAT" | /bin/cat; printf "SHELL_STDERR\\n" >&2; exit 7'
  ])
  assert.deepEqual(shell, {
    code: 7,
    signal: null,
    stderr: 'SHELL_STDERR\n',
    stdout: 'SHELL_TO_CAT'
  })
  const tools = {}
  if (profile === 'agent') {
    for (
      const [id, path, args] of [
        ['curl', '/usr/bin/curl', ['--version']],
        ['git', '/usr/bin/git', ['--version']],
        ['jq', '/usr/bin/jq', ['--version']],
        ['ssh', '/usr/bin/ssh', ['-V']]
      ]
    ) {
      const result = await execute(id, path, args)
      assert.equal(result.code, 0, `${id} probe failed: ${JSON.stringify(result)}`)
      tools[id] = `${result.stdout}${result.stderr}`.split('\n')[0]
    }
  }
  process.stdout.write(`${JSON.stringify({ profile, shell, tools, verified: true })}\n`)
} catch (error) {
  process.stderr.write(`[probe-error] ${error instanceof Error ? error.stack : String(error)}\n`)
  process.stderr.write(`${serial}\n`)
  throw error
} finally {
  await backend.closeGeneration(1)
}
