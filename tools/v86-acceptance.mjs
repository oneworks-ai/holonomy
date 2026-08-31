#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { V86_NODE_ACCEPTANCE_FILES_V1, v86AcceptancePhasesV1 } from './v86-acceptance-plan.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const requiredAssets = Object.freeze([
  'agent.cpio',
  'agent.manifest.json',
  'agent.spdx.json',
  'kernel.bin',
  'libv86.mjs',
  'seabios.bin',
  'v86.wasm'
])

const fail = message => {
  throw new Error(`v86 acceptance failed: ${message}`)
}

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error != null) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const assetRoot = name => {
  const value = process.env[name]
  if (
    typeof value !== 'string' || value === '' || !isAbsolute(value) || normalize(value) !== value ||
    !existsSync(value) || !statSync(value).isDirectory() || realpathSync(value) !== value
  ) fail(`${name} must name a real absolute asset directory`)
  for (const file of requiredAssets) {
    const path = join(value, file)
    if (!existsSync(path) || !statSync(path).isFile()) fail(`${name} is missing ${file}`)
  }
  run(process.execPath, [
    resolve(root, 'backends/v86/images/verify-image.mjs'),
    join(value, 'agent.manifest.json')
  ])
  return value
}

const requiredFile = name => {
  const value = process.env[name]
  if (
    typeof value !== 'string' || value === '' || !isAbsolute(value) || normalize(value) !== value ||
    !existsSync(value) || !statSync(value).isFile() || realpathSync(value) !== value
  ) fail(`${name} must name a real absolute file`)
  return value
}

const nodeAcceptance = () => {
  const value = assetRoot('HOLO_V86_PRODUCTION_ASSET_ROOT')
  run('pnpm', ['run', 'build'])
  run(process.execPath, [
    '--experimental-vm-modules',
    '--test',
    ...V86_NODE_ACCEPTANCE_FILES_V1
  ], { ...process.env, HOLO_V86_PRODUCTION_ASSET_ROOT: value })
}

const androidAcceptance = () => {
  const value = assetRoot('HOLO_V86_ANDROID_ASSET_ROOT')
  // Android Runtime assets are assembled from workspace dist outputs. Always
  // rebuild them here so the acceptance APK cannot silently package stale JS.
  run('pnpm', ['run', 'build'])
  run(process.execPath, ['tools/android-device-tests.mjs', '--require-v86'], {
    ...process.env,
    HOLO_V86_ANDROID_ASSET_ROOT: value
  })
}

const guestAcceptance = () => {
  const value = assetRoot('HOLO_V86_PRODUCTION_ASSET_ROOT')
  const zig = requiredFile('HOLO_V86_ZIG_PATH')
  run('pnpm', ['run', 'build'])
  const output = mkdtempSync(join(tmpdir(), 'holonomy-v86-guest-'))
  try {
    run(process.execPath, [
      resolve(root, 'backends/v86/build-supervisor.mjs'),
      zig,
      output,
      '--include-selftest'
    ])
    const image = join(output, 'conformance.cpio')
    run(process.execPath, [
      resolve(root, 'backends/v86/build-conformance-image.mjs'),
      join(value, 'agent.cpio'),
      join(output, 'holo-uvd'),
      join(output, 'hoholo'),
      join(output, 'holo-v86-selftest'),
      image
    ])
    run(process.execPath, [
      resolve(root, 'backends/v86/probe-real.mjs'),
      join(value, 'libv86.mjs'),
      join(value, 'v86.wasm'),
      join(value, 'seabios.bin'),
      join(value, 'kernel.bin'),
      image
    ], { ...process.env, HOLO_V86_REQUIRED_KERNEL_CAPABILITIES: 'process,fuse,seccompUserNotification' })
  } finally {
    rmSync(output, { force: true, recursive: true })
  }
}

const actions = {
  android: androidAcceptance,
  guest: guestAcceptance,
  images: () => assetRoot('HOLO_V86_PRODUCTION_ASSET_ROOT'),
  node: nodeAcceptance
}
let phases
try {
  phases = v86AcceptancePhasesV1(process.argv[2])
} catch {
  fail('expected images, node, android, guest or all')
}
for (const phase of phases) actions[phase]()
