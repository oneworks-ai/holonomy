import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { readServiceProcessBackendsV1 } from '../capability-process-backends.mjs'
import { readServiceProcessProfilesV1 } from '../capability-process-profiles.mjs'

const profile = {
  backend: {
    backendId: 'native.darwin-seatbelt-v1',
    configuration: {
      runtimeReadPaths: ['/opt/homebrew'],
      sandboxExecutablePath: '/usr/bin/sandbox-exec'
    }
  },
  environment: { allowedScopes: ['processTree'], defaultScope: 'processTree' },
  executables: [{
    executableId: 'git',
    executablePath: '/usr/bin/git',
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
}

describe('service Process profile manifest', () => {
  it.skipIf(process.platform !== 'darwin')(
    'loads only an owner-private Host manifest and hides native details from launch input',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'holonomy-process-profiles-'))
      const path = join(directory, 'process-profiles.json')
      try {
        await writeFile(path, JSON.stringify({ profiles: { developer: profile }, schemaVersion: 1 }), { mode: 0o600 })
        const profiles = await readServiceProcessProfilesV1(path)
        assert.deepEqual(profiles.developer.environment, {
          allowedScopes: ['processTree'],
          defaultScope: 'processTree'
        })
        assert.equal(profiles.developer.backend.backendId, 'native.darwin-seatbelt-v1')
        assert.deepEqual(profiles.developer.executables[0].executable, {
          kind: 'hostPath',
          path: '/usr/bin/git'
        })

        await chmod(path, 0o644)
        await assert.rejects(readServiceProcessProfilesV1(path), error => error.code === 'service.state_corrupt')
      } finally {
        await rm(directory, { force: true, recursive: true })
      }
    }
  )

  it('treats an absent Host manifest as no published Process profiles', async () => {
    const profiles = await readServiceProcessProfilesV1('/definitely/missing/holonomy/process-profiles.json')
    assert.deepEqual(profiles, {})
  })

  it('verifies every v86 asset before publishing a virtual Linux profile', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holonomy-v86-profile-'))
    const backendPath = join(directory, 'process-backends.json')
    const profilePath = join(directory, 'process-profiles.json')
    const values = Object.fromEntries(
      ['bios', 'initrd', 'kernel', 'wasm'].map(id => [id, Buffer.from(`verified-${id}`)])
    )
    const artifact = artifactId => ({
      artifactId,
      sha256: createHash('sha256').update(values[artifactId]).digest('hex')
    })
    try {
      for (const [id, value] of Object.entries(values)) {
        await writeFile(join(directory, id), value, { mode: 0o600 })
      }
      await writeFile(
        backendPath,
        JSON.stringify({
          backends: {
            'experimental.v86-v1': {
              artifactRoot: directory,
              implementation: 'builtin.v86-v1'
            }
          },
          schemaVersion: 1
        }),
        { mode: 0o600 }
      )
      await writeFile(
        profilePath,
        JSON.stringify({
          profiles: {
            linux: {
              backend: {
                backendId: 'experimental.v86-v1',
                configuration: {
                  artifacts: {
                    bios: artifact('bios'),
                    initrd: artifact('initrd'),
                    kernel: artifact('kernel'),
                    wasm: artifact('wasm')
                  },
                  memoryBytes: 64 * 1024 * 1024,
                  requiredKernelCapabilities: ['process', 'fuse', 'tun'],
                  supervisor: { protocolVersion: 1 }
                }
              },
              environment: {
                allowedScopes: ['runtime', 'processTree'],
                defaultScope: 'runtime'
              },
              executables: [{
                executable: { kind: 'guestPath', path: '/holo-selftest' },
                executableId: 'selftest',
                fixedArgs: [],
                shell: false
              }],
              profile: 'process-profile-v1'
            }
          },
          schemaVersion: 1
        }),
        { mode: 0o600 }
      )
      const backends = await readServiceProcessBackendsV1(backendPath)
      const profiles = await readServiceProcessProfilesV1(profilePath, {
        processBackendInstallations: backends.installations,
        processBackendRegistry: backends.registry
      })
      assert.equal(profiles.linux.backend.backendId, 'experimental.v86-v1')
      assert.equal(profiles.linux.executables[0].executable.path, '/holo-selftest')

      await writeFile(join(directory, 'kernel'), 'tampered', { mode: 0o600 })
      await assert.rejects(
        readServiceProcessProfilesV1(profilePath, {
          processBackendInstallations: backends.installations,
          processBackendRegistry: backends.registry
        }),
        error => error.code === 'service.state_corrupt'
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
