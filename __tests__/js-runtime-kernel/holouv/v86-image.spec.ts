import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { normalizeImageProfileV1 } from '../../../backends/v86/images/image-contract.mjs'
import { createNewcArchiveFromEntriesV1, parseNewcArchiveV1 } from '../../../backends/v86/images/newc.mjs'

const execute = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('v86 image profiles', () => {
  it('builds and verifies a deterministic production minimal initramfs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holonomy-v86-image-test-'))
    roots.push(root)
    const supervisor = join(root, 'holo-uvd')
    const elf = new Uint8Array(20)
    elf.set([0x7F, 0x45, 0x4C, 0x46, 1, 1], 0)
    elf.set([3, 0], 18)
    await writeFile(supervisor, elf, { mode: 0o755 })
    const builder = resolve('backends/v86/images/build-image.mjs')
    const verifier = resolve('backends/v86/images/verify-image.mjs')
    const first = join(root, 'first')
    const second = join(root, 'second')
    await execute(process.execPath, [builder, 'minimal', supervisor, first])
    await execute(process.execPath, [builder, 'minimal', supervisor, second])
    const firstImage = await readFile(join(first, 'minimal.cpio'))
    const secondImage = await readFile(join(second, 'minimal.cpio'))
    expect(firstImage).toEqual(secondImage)
    const result = JSON.parse(
      (await execute(process.execPath, [
        verifier,
        join(first, 'minimal.manifest.json')
      ])).stdout
    )
    expect(result).toMatchObject({ profileId: 'minimal', verified: true })
    expect(new TextDecoder().decode(firstImage)).not.toContain('holo-selftest')
  })

  it('builds a deterministic private conformance overlay on a production image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holonomy-v86-conformance-image-test-'))
    roots.push(root)
    const elf = new Uint8Array(20)
    elf.set([0x7F, 0x45, 0x4C, 0x46, 1, 1], 0)
    elf.set([3, 0], 18)
    const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)
    const baseImage = createNewcArchiveFromEntriesV1([
      { bytes: new Uint8Array(), mode: 0o040755, name: 'etc' },
      { bytes: new Uint8Array(), mode: 0o040755, name: 'etc/holo' },
      {
        bytes: encode({
          architecture: 'linux-x86-32',
          capabilityClient: { path: '/usr/bin/hoholo', sha256: 'old-client' },
          kernel: { release: 'test' },
          profileId: 'agent',
          rootfs: { version: 'test' },
          schemaVersion: 1,
          supervisor: { path: '/sbin/holo-uvd', sha256: 'old-supervisor' }
        }),
        mode: 0o100444,
        name: 'etc/holo/image-profile-v1.json'
      },
      { bytes: new Uint8Array(), mode: 0o040755, name: 'lib' },
      { bytes: new Uint8Array(), mode: 0o040755, name: 'lib/modules' },
      { bytes: new Uint8Array(), mode: 0o040755, name: 'sbin' },
      { bytes: elf, mode: 0o100755, name: 'sbin/holo-uvd' },
      { bytes: new TextEncoder().encode('/bin/busybox'), mode: 0o120755, name: 'sbin/modprobe' },
      { bytes: new Uint8Array(), mode: 0o040755, name: 'usr' },
      { bytes: new Uint8Array(), mode: 0o040755, name: 'usr/bin' },
      { bytes: elf, mode: 0o100755, name: 'usr/bin/hoholo' }
    ])
    const basePath = join(root, 'agent.cpio')
    const supervisorPath = join(root, 'holo-uvd')
    const clientPath = join(root, 'hoholo')
    const fixturePath = join(root, 'holo-v86-selftest')
    await Promise.all([
      writeFile(basePath, baseImage),
      writeFile(supervisorPath, elf),
      writeFile(clientPath, elf),
      writeFile(fixturePath, elf)
    ])
    const builder = resolve('backends/v86/build-conformance-image.mjs')
    const first = join(root, 'first.cpio')
    const second = join(root, 'second.cpio')
    await execute(process.execPath, [builder, basePath, supervisorPath, clientPath, fixturePath, first])
    await execute(process.execPath, [builder, basePath, supervisorPath, clientPath, fixturePath, second])
    const firstImage = await readFile(first)
    expect(firstImage).toEqual(await readFile(second))
    const entries = parseNewcArchiveV1(firstImage)
    const byName = new Map(entries.map(value => [value.name, value]))
    expect(byName.has('holo-selftest')).toBe(false)
    expect([...(byName.get('usr/bin/holo-v86-selftest')?.bytes ?? [])]).toEqual([...elf])
    expect([...(byName.get('sbin/holo-uvd')?.bytes ?? [])]).toEqual([...elf])
    expect([...(byName.get('usr/bin/hoholo')?.bytes ?? [])]).toEqual([...elf])
    const overlayEntry = byName.get('etc/holo/conformance-overlay-v1.json')
    expect(overlayEntry).toBeDefined()
    if (overlayEntry == null) throw new Error('Missing conformance overlay')
    const overlay = JSON.parse(new TextDecoder().decode(overlayEntry.bytes))
    expect(overlay).toMatchObject({
      capabilityClient: { path: '/usr/bin/hoholo' },
      fixture: { path: '/usr/bin/holo-v86-selftest' },
      schemaVersion: 1,
      supervisor: { path: '/sbin/holo-uvd' }
    })
  })

  it('rejects custom ambient packages and executable path aliases', () => {
    expect(() =>
      normalizeImageProfileV1({
        executables: [],
        id: 'custom.example',
        packages: ['unlocked'],
        rootfs: 'empty',
        schemaVersion: 1
      })
    ).toThrow(TypeError)
    expect(() =>
      normalizeImageProfileV1({
        executables: [{ executableId: 'tool', path: '/bin/../bin/tool', shell: false }],
        id: 'custom.example',
        packages: [],
        rootfs: 'alpine',
        schemaVersion: 1
      })
    ).toThrow(TypeError)
  })
})
