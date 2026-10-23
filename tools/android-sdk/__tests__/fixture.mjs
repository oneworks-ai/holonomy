import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sha256 } from '../../artifact-archive/files.mjs'
import { SDK_MODULES, SDK_SOURCE_FILES } from '../files.mjs'

export const write = async (root, path, bytes) => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), bytes)
}

export const fixture = async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-sdk-tool-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const source of Object.values(SDK_SOURCE_FILES)) await write(root, source, 'fixture source\n')
  await write(root, 'package.json', JSON.stringify({ version: '1.0.0-rc.3' }))
  await write(root, 'pnpm-lock.yaml', 'fixture lock\n')
  await write(root, 'adapters/android/build.gradle.kts', 'fixture gradle\n')
  const aar = join(root, 'aar-source')
  const bootstrap = Buffer.from('fixture bootstrap\n')
  await write(root, 'adapters/android/runtime-host/src/runtimeBootstrap/bootstrap.mjs', bootstrap)
  await write(aar, 'AndroidManifest.xml', '<manifest/>')
  await write(aar, 'classes.jar', 'fixture classes')
  await write(aar, 'assets/runtime/bootstrap.mjs', bootstrap)
  await write(
    aar,
    'assets/runtime/asset-manifest.json',
    JSON.stringify({
      schemaVersion: 2,
      assets: [{
        path: 'runtime/bootstrap.mjs',
        sha256: sha256(bootstrap),
        source: 'adapters/android/runtime-host/src/runtimeBootstrap/bootstrap.mjs'
      }],
      moduleAliases: [],
      typescriptSources: []
    })
  )
  const zip = join(root, 'fixture.aar')
  const result = spawnSync('/usr/bin/zip', ['-qr', zip, '.'], { cwd: aar, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  for (const module of SDK_MODULES) {
    const target = join(root, 'adapters/android', module, 'build/outputs/aar', `${module}-debug.aar`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(zip, target)
  }
  return root
}
