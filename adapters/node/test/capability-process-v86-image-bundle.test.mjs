import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
// eslint-disable-next-line test/no-import-node-test -- Adapter tests use Node's public runner.
import test from 'node:test'

import { createNewcArchiveFromEntriesV1 } from '../../../backends/v86/images/newc.mjs'
import { verifyInstalledV86ImageBundleV1 } from '../src/capability-process-v86-image-bundle.mjs'

const bytes = value => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
const digest = value => createHash('sha256').update(value).digest('hex')
const executable = Object.freeze({ executableId: 'tool', path: '/bin/tool', shell: false })
const profileDigest = '1'.repeat(64)

const profile = executables => ({
  backend: {
    backendId: 'experimental.v86-v1',
    configuration: {
      artifacts: {
        initrd: { artifactId: 'agent.cpio' }
      }
    }
  },
  executables: executables.map(value => ({
    executable: { kind: 'guestPath', path: value.path },
    executableId: value.executableId,
    fixedArgs: [],
    shell: value.shell
  }))
})

const bundle = (options = {}) => {
  const embedded = bytes({
    architecture: 'linux-x86-32',
    executables: [executable],
    packages: [],
    profileDigest,
    profileId: 'agent',
    schemaVersion: 1,
    supervisor: { path: '/sbin/holo-uvd', sha256: '2'.repeat(64) }
  })
  const image = createNewcArchiveFromEntriesV1([
    { bytes: new Uint8Array([0x7F, 0x45, 0x4C, 0x46]), mode: 0o100755, name: 'sbin/holo-uvd' },
    { bytes: new Uint8Array([0x7F, 0x45, 0x4C, 0x46]), mode: 0o100755, name: 'bin/tool' },
    { bytes: embedded, mode: 0o100444, name: 'etc/holo/image-profile-v1.json' },
    ...options.entries ?? []
  ])
  const imageSha256 = digest(image)
  const sbom = bytes({
    documentNamespace: `https://holonomy.dev/spdx/v86/agent/${imageSha256}`,
    packages: [],
    spdxVersion: 'SPDX-2.3'
  })
  const manifest = bytes({
    architecture: 'linux-x86-32',
    artifact: { name: 'agent.cpio', sha256: imageSha256, size: image.byteLength },
    executables: options.manifestExecutables ?? [executable],
    kernel: null,
    packageCount: 0,
    profileDigest,
    profileId: 'agent',
    rootfs: null,
    sbom: { name: 'agent.spdx.json', sha256: digest(sbom), size: sbom.byteLength },
    schemaVersion: 1,
    supervisorSha256: '2'.repeat(64)
  })
  const values = new Map([
    ['agent.cpio', image],
    ['agent.manifest.json', manifest],
    ['agent.spdx.json', sbom]
  ])
  return {
    imageSha256,
    read: async name => {
      const value = values.get(name)
      if (value == null) throw new Error(`missing fixture: ${name}`)
      return value
    }
  }
}

test('binds the installed cpio, manifest, SBOM and executable projection', async () => {
  const value = bundle()
  const result = await verifyInstalledV86ImageBundleV1(
    {
      ...profile([{ executableId: 'host-alias', path: executable.path, shell: false }]),
      backend: {
        backendId: 'experimental.v86-v1',
        configuration: {
          artifacts: {
            initrd: { artifactId: 'agent.cpio', sha256: value.imageSha256 }
          }
        }
      }
    },
    value.read
  )

  assert.deepEqual(result, {
    artifactSha256: value.imageSha256,
    executableIds: ['tool'],
    profileDigest,
    profileId: 'agent',
    sbomSha256: digest(await value.read('agent.spdx.json'))
  })
})

test('rejects executable projections outside the signed image bundle', async () => {
  const value = bundle()
  await assert.rejects(
    verifyInstalledV86ImageBundleV1(
      {
        ...profile([{ executableId: 'other', path: '/bin/other', shell: false }]),
        backend: {
          backendId: 'experimental.v86-v1',
          configuration: {
            artifacts: {
              initrd: { artifactId: 'agent.cpio', sha256: value.imageSha256 }
            }
          }
        }
      },
      value.read
    ),
    TypeError
  )
})

test('rejects manifest drift and production selftest fixtures', async () => {
  const drift = bundle({
    manifestExecutables: [{ executableId: 'other', path: '/bin/tool', shell: false }]
  })
  await assert.rejects(
    verifyInstalledV86ImageBundleV1(
      {
        ...profile([executable]),
        backend: {
          backendId: 'experimental.v86-v1',
          configuration: {
            artifacts: {
              initrd: { artifactId: 'agent.cpio', sha256: drift.imageSha256 }
            }
          }
        }
      },
      drift.read
    ),
    TypeError
  )

  const selftest = bundle({
    entries: [{ bytes: new Uint8Array([0x7F, 0x45, 0x4C, 0x46]), mode: 0o100755, name: 'usr/bin/holo-v86-selftest' }]
  })
  await assert.rejects(
    verifyInstalledV86ImageBundleV1(
      {
        ...profile([executable]),
        backend: {
          backendId: 'experimental.v86-v1',
          configuration: {
            artifacts: {
              initrd: { artifactId: 'agent.cpio', sha256: selftest.imageSha256 }
            }
          }
        }
      },
      selftest.read
    ),
    TypeError
  )
})
