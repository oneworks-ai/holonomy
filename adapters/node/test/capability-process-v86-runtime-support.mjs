import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

export const assetRoot = process.env.HOLO_V86_PRODUCTION_ASSET_ROOT
export const entryUrl = 'app+local://workspace/main.mjs'
export const moduleRootUrl = 'app+local://workspace/'

export const processProfileV1 = async root => {
  const files = {
    bios: 'seabios.bin',
    initrd: 'agent.cpio',
    kernel: 'kernel.bin',
    wasm: 'v86.wasm'
  }
  const artifacts = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([key, artifactId]) => [
        key,
        {
          artifactId,
          sha256: createHash('sha256').update(await readFile(path.join(root, artifactId))).digest('hex')
        }
      ])
    )
  )
  return {
    backend: {
      backendId: 'experimental.v86-v1',
      configuration: {
        artifacts,
        memoryBytes: 128 * 1024 * 1024,
        requiredKernelCapabilities: ['process', 'fuse', 'seccompUserNotification'],
        supervisor: { protocolVersion: 1 }
      }
    },
    environment: {
      allowedScopes: ['processTree'],
      capabilityBridge: { domains: ['device', 'system'] },
      defaultScope: 'processTree'
    },
    executables: [
      {
        executable: { kind: 'guestPath', path: '/bin/sh' },
        executableId: 'shell',
        fixedArgs: [],
        shell: true
      },
      {
        executable: { kind: 'guestPath', path: '/bin/cat' },
        executableId: 'cat',
        fixedArgs: [],
        shell: false
      },
      {
        executable: { kind: 'guestPath', path: '/usr/bin/curl' },
        executableId: 'curl',
        fixedArgs: [],
        shell: false
      },
      {
        executable: { kind: 'guestPath', path: '/usr/bin/hoholo' },
        executableId: 'hoholo',
        fixedArgs: [],
        shell: false
      },
      {
        executable: { kind: 'guestPath', path: '/usr/bin/nc' },
        executableId: 'nc',
        fixedArgs: [],
        shell: false
      },
      ...[
        ['ls', '/bin/ls'],
        ['mkdir', '/bin/mkdir'],
        ['mv', '/bin/mv'],
        ['rm', '/bin/rm'],
        ['rmdir', '/bin/rmdir'],
        ['timeout', '/usr/bin/timeout']
      ].map(([executableId, executablePath]) => ({
        executable: { kind: 'guestPath', path: executablePath },
        executableId,
        fixedArgs: [],
        shell: false
      }))
    ],
    profile: 'process-profile-v1'
  }
}
