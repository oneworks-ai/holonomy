import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { materializeNativeLaunch } from '../native-launch-materialization.mjs'
import {
  readServiceNativeRuntimeInstallation,
  readServiceNativeRuntimeInstallationDetails
} from '../native-runtime-installation.mjs'

const selector = Object.freeze({ implementation: 'builtin.darwin-device-v1' })
const rootUrl = 'app://workspace/'
const processRecord = Object.freeze({
  entryUrl: `${rootUrl}main.mjs`,
  generation: 1,
  id: 'native_device_private',
  launch: {
    argv: [`${rootUrl}main.mjs`],
    command: 'test',
    entryUrl: `${rootUrl}main.mjs`,
    moduleRootUrl: rootUrl,
    modules: [{ source: 'console.log("device")', url: `${rootUrl}main.mjs` }],
    schemaVersion: 2,
    target: 'native'
  },
  target: 'native'
})

describe('owner-only Native Device installation', () => {
  it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
    'keeps the optional selector in private Host stage and preserves the path API',
    async () => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'holo-device-install-')))
      const executable = join(directory, 'holo')
      const manifest = join(directory, 'native-runtime.json')
      await writeFile(executable, '', { mode: 0o700 })
      await chmod(executable, 0o700)
      await writeFile(
        manifest,
        JSON.stringify({ deviceProvider: selector, executablePath: executable, schemaVersion: 1 }),
        {
          mode: 0o600
        }
      )
      try {
        const details = await readServiceNativeRuntimeInstallationDetails(directory)
        assert.deepEqual(details, { deviceProvider: selector, executablePath: executable })
        assert.equal(await readServiceNativeRuntimeInstallation(directory), executable)
        const staged = await materializeNativeLaunch(
          processRecord,
          directory,
          undefined,
          () => {},
          details.deviceProvider
        )
        try {
          const hostConfig = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
          assert.deepEqual(hostConfig.deviceProvider, selector)
          assert.deepEqual(staged.hostConfig.deviceProvider, selector)
          assert.equal(JSON.stringify(hostConfig).includes('executablePath'), false)
        } finally {
          await rm(staged.generationRoot, { force: true, recursive: true })
        }
        for (
          const invalid of [
            { deviceProvider: null, executablePath: executable, schemaVersion: 1 },
            { deviceProvider: { implementation: 'other' }, executablePath: executable, schemaVersion: 1 },
            { deviceProvider: { ...selector, source: 'guest' }, executablePath: executable, schemaVersion: 1 },
            { ...selector, executablePath: executable, schemaVersion: 1 }
          ]
        ) {
          await writeFile(manifest, JSON.stringify(invalid), { mode: 0o600 })
          await assert.rejects(readServiceNativeRuntimeInstallationDetails(directory), {
            code: 'service.state_corrupt'
          })
        }
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    }
  )
})
