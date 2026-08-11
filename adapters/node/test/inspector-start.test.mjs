import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
// eslint-disable-next-line test/no-import-node-test -- This adapter is verified with Node's public test runner.
import test from 'node:test'

import { NodeRuntimeSupervisor } from '../src/supervisor.mjs'

const entryUrl = 'app://inspector/main.mjs'
const session = (source, waitForDebugger) => ({
  entryUrl,
  inspector: { enabled: true, waitForDebugger },
  runtimeModules: [],
  syntheticModules: {},
  userModules: [{ source, url: entryUrl }]
})

const waitForLog = async (logs, text) => {
  for (let turn = 0; turn < 500; turn += 1) {
    if (logs.some(event => event.text === text)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Node Runtime log was not observed: ${text}`)
}

const resumeInspector = url =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => reject(new Error('Inspector resume timed out')), 5_000)
    const finish = error => {
      clearTimeout(timeout)
      socket.close()
      error == null ? resolve() : reject(error)
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.runIfWaitingForDebugger' }))
    }, { once: true })
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data))
      if (message.id === 1) finish(message.error == null ? undefined : new Error('Inspector resume failed'))
    })
    socket.addEventListener('error', () => finish(new Error('Inspector connection failed')), { once: true })
  })

const readJsonLine = stream =>
  new Promise((resolve, reject) => {
    let text = ''
    stream.on('data', chunk => {
      text += chunk
      const end = text.indexOf('\n')
      if (end < 0) return
      try {
        resolve(JSON.parse(text.slice(0, end)))
      } catch (error) {
        reject(error)
      }
    })
    stream.on('error', reject)
  })

const processExists = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('publishes a normal inspector endpoint before a pending entry finishes', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))

  const status = await supervisor.start(session(
    `await new Promise(resolve => setTimeout(resolve, 250)); console.log('INSPECT_ENTRY')`,
    false
  ))
  assert.equal(status.state, 'running')
  assert.match(status.inspectorUrl, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+$/u)
  assert.equal(logs.some(event => event.text === 'INSPECT_ENTRY'), false)
  await waitForLog(logs, 'INSPECT_ENTRY')
})

test('publishes break readiness before entry and runs only after CDP resume', async t => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  t.after(() => supervisor.stop())
  const logs = []
  supervisor.on('log', event => logs.push(event))

  const status = await supervisor.start(session(`console.log('BREAK_ENTRY')`, true))
  assert.equal(status.state, 'waiting_for_debugger')
  assert.equal(supervisor.state, 'waiting_for_debugger')
  assert.equal(logs.some(event => event.text === 'BREAK_ENTRY'), false)
  await resumeInspector(status.inspectorUrl)
  await supervisor.resume()
  assert.equal(supervisor.state, 'running')
  await waitForLog(logs, 'BREAK_ENTRY')
})

test('stops a waiting child without blocked IPC and fences its late state', async () => {
  const supervisor = new NodeRuntimeSupervisor({ requestTimeoutMs: 5_000 })
  await supervisor.start(session(`console.log('NEVER_RUN')`, true))
  await Promise.race([
    supervisor.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Waiting stop timed out')), 1_000))
  ])
  assert.equal(supervisor.state, 'stopped')
  const next = await supervisor.start({
    entryUrl,
    runtimeModules: [],
    syntheticModules: {},
    userModules: [{ source: 'export default 1', url: entryUrl }]
  })
  assert.equal(next.generation, 2)
  assert.equal(supervisor.state, 'running')
  await supervisor.stop()
})

test('exits a waiting child when its supervisor owner is killed', async t => {
  const owner = spawn(process.execPath, [
    new URL('./fixtures/waiting-supervisor-parent.mjs', import.meta.url).pathname
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childPid
  t.after(() => {
    if (owner.exitCode == null && owner.signalCode == null) owner.kill('SIGKILL')
    if (childPid != null && processExists(childPid)) process.kill(childPid, 'SIGKILL')
  })
  const ready = await readJsonLine(owner.stdout)
  childPid = ready.childPid
  assert.equal(processExists(childPid), true)
  const ownerExit = new Promise(resolve => owner.once('exit', resolve))
  owner.kill('SIGKILL')
  await ownerExit
  for (let turn = 0; turn < 300 && processExists(childPid); turn += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(processExists(childPid), false)
})
