import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { buildAndInstall, findAdb, root, run, selectDevice } from './android-devtools-adb.mjs'
import { readTarget, resumeTarget } from './android-devtools-cdp.mjs'
import { encodeHolonomySession } from './holonomy-session-envelope.mjs'

const packageName = 'ai.oneworks.holonomy.e2e'
const activityName = `${packageName}/.HolonomyRuntimeActivity`

export const androidNetworkFixtureReverseArgs = (serial, port) => {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('Network fixture port must be 1..65535')
  }
  return Object.freeze({
    add: Object.freeze(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]),
    remove: Object.freeze(['-s', serial, 'reverse', '--remove', `tcp:${port}`])
  })
}

const adbWithInput = (adb, args, input) => {
  const result = spawnSync(adb, args, { encoding: 'utf8', input })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'adb failed').trim())
}

const readSandboxFile = (adb, serial, path) => {
  const result = spawnSync(adb, ['-s', serial, 'shell', 'run-as', packageName, 'cat', path], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : undefined
}

const waitForResult = async (adb, serial, path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = readSandboxFile(adb, serial, path)
    if (value?.trim()) return JSON.parse(value)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('Timed out waiting for the Android runtime process')
}

const cancelSession = async (adb, serial, sessionId, directory) => {
  run(adb, [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    activityName,
    '--es',
    'holonomy.session.id',
    sessionId,
    '--ez',
    'holonomy.session.cancel',
    'true'
  ])
  await waitForResult(adb, serial, `${directory}/result.json`, 10_000)
}

const printOutput = output => {
  for (const line of output.trim().split('\n')) {
    if (!line) continue
    const event = JSON.parse(line)
    const target = event.stream === 'stderr' ? process.stderr : process.stdout
    target.write(event.chunk)
  }
}

const openElectron = port => {
  const executable = resolve(root, `node_modules/.bin/electron${process.platform === 'win32' ? '.cmd' : ''}`)
  if (!existsSync(executable)) throw new Error('Electron is unavailable. Run pnpm install first.')
  const child = spawn(executable, [
    resolve(root, 'tools/android-devtools-electron.mjs'),
    `--discovery-url=http://127.0.0.1:${port}/json/list`
  ], { cwd: root, detached: true, stdio: 'ignore' })
  child.unref()
}

export const runAndroidSession = async (request, options) => {
  const adb = findAdb()
  const serial = selectDevice(adb, options.serial)
  if (options.build) buildAndInstall(adb, serial, packageName)
  const sessionId = request.sessionId
  const directory = `files/sessions/${sessionId}`
  run(adb, ['-s', serial, 'shell', 'run-as', packageName, 'mkdir', '-p', directory])
  const reverse = options.networkFixturePort == null
    ? undefined
    : androidNetworkFixtureReverseArgs(serial, options.networkFixturePort)
  let forwarded = false
  let reversed = false
  let sessionCompleted = false
  let sessionStarted = false
  try {
    if (reverse != null) {
      run(adb, reverse.add)
      reversed = true
    }
    adbWithInput(
      adb,
      ['-s', serial, 'shell', 'run-as', packageName, 'tee', `${directory}/request.json`],
      encodeHolonomySession(request.payload)
    )
    if (options.inspect != null) {
      run(adb, ['-s', serial, 'forward', `tcp:${options.inspect.port}`, `localabstract:${request.socketName}`])
      forwarded = true
    }
    run(adb, [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      activityName,
      '--es',
      'holonomy.session.id',
      sessionId
    ])
    sessionStarted = true
    if (options.inspect != null) {
      const target = await readTarget(options.inspect.port)
      if (!options.inspect.breakBeforeEntry) await resumeTarget(target)
      process.stderr.write(`Inspector: http://127.0.0.1:${options.inspect.port}/json/list\n`)
      if (options.openDevTools) openElectron(options.inspect.port)
    }
    const result = await waitForResult(adb, serial, `${directory}/result.json`, options.timeoutMs)
    sessionCompleted = true
    const output = readSandboxFile(adb, serial, `${directory}/output.jsonl`)
    if (output) printOutput(output)
    if (result.error) process.stderr.write(`${result.error}\n`)
    if (result.exitCode !== 0 && !options.allowFailures) process.exitCode = result.exitCode
  } finally {
    try {
      if (sessionStarted && !sessionCompleted) await cancelSession(adb, serial, sessionId, directory)
    } finally {
      try {
        if (forwarded) run(adb, ['-s', serial, 'forward', '--remove', `tcp:${options.inspect.port}`])
      } finally {
        try {
          if (reversed) run(adb, reverse.remove)
        } finally {
          run(adb, ['-s', serial, 'shell', 'run-as', packageName, 'rm', '-r', directory])
        }
      }
    }
  }
}
