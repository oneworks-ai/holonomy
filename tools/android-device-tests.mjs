#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import process from 'node:process'

import {
  androidBuildEnvironment,
  androidRoot,
  findAdb,
  listDevices,
  run,
  selectDevice
} from './android-devtools-adb.mjs'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function parseArgs(args) {
  const options = { allDevices: false, physicalOnly: false, serials: [] }
  while (args.length > 0) {
    const argument = args.shift()
    if (argument === '--serial') options.serials.push(args.shift())
    else if (argument === '--all-devices') options.allDevices = true
    else if (argument === '--physical-only') options.physicalOnly = true
    else fail(`Unknown option: ${argument}`)
  }
  if (options.allDevices && options.serials.length > 0) fail('Use either --all-devices or --serial, not both')
  return options
}

function deviceKind(adb, serial) {
  return run(adb, ['-s', serial, 'shell', 'getprop', 'ro.kernel.qemu']) === '1'
    ? 'emulator'
    : 'physical'
}

function executeDeviceSuite(adb, serial) {
  const startedAt = Date.now()
  const result = spawnSync(
    './gradlew',
    ['--no-daemon', ':e2e:connectedDebugAndroidTest'],
    {
      cwd: androidRoot,
      encoding: 'utf8',
      env: { ...androidBuildEnvironment(adb), ANDROID_SERIAL: serial },
      stdio: 'inherit'
    }
  )
  return {
    durationMs: Date.now() - startedAt,
    kind: deviceKind(adb, serial),
    passed: result.status === 0,
    serial
  }
}

const options = parseArgs(process.argv.slice(2))
const adb = findAdb()
let serials = options.allDevices
  ? listDevices(adb)
  : options.serials.length > 0
  ? options.serials.map(serial => selectDevice(adb, serial))
  : [selectDevice(adb)]
if (options.physicalOnly) serials = serials.filter(serial => deviceKind(adb, serial) === 'physical')
if (serials.length === 0) fail('No matching online Android devices were found')

const results = serials.map(serial => executeDeviceSuite(adb, serial))
const report = {
  passed: results.every(result => result.passed),
  results
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
