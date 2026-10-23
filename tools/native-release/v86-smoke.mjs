import { chmod, copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const json = value => `${JSON.stringify(value, null, 2)}\n`

export const prepareNativeV86CatExample = async ({ bundle, assets }) => {
  const privateRoot = join(bundle, 'private')
  const paths = {
    host: join(privateRoot, 'host-cat.json'),
    profiles: join(privateRoot, 'process-profiles.json'),
    backends: join(privateRoot, 'process-backends.json')
  }
  await writeFile(
    paths.host,
    json({
      schemaVersion: 1,
      processProfileId: 'linux',
      sandboxPolicy: {
        schemaVersion: 2,
        process: {
          access: 'sandboxed',
          environment: { allowedNames: [], maxValueBytes: 1024 },
          executables: [{ executableId: 'cat', argumentBytes: 1024 }],
          shell: { access: 'none' },
          mounts: [],
          network: { access: 'none' },
          limits: {
            maxConcurrentProcesses: 1,
            maxTotalProcesses: 1,
            maxProcessTreeDepth: 1,
            maxExecutionTimeMs: 30000,
            maxStdinBytes: 4096,
            maxStdoutBytes: 4096,
            maxStderrBytes: 4096,
            maxOpenPipes: 3,
            maxWritableRootfsBytes: 0
          }
        }
      }
    }),
    { mode: 0o600 }
  )
  const spec = (name, artifactId) => ({ artifactId, sha256: assets[name].sha256 })
  await writeFile(
    paths.profiles,
    json({
      schemaVersion: 1,
      profiles: {
        linux: {
          profile: 'process-profile-v1',
          backend: {
            backendId: 'experimental.v86-v1',
            configuration: {
              artifacts: {
                bios: spec('seabios.bin', 'seabios.bin'),
                kernel: spec('kernel.bin', 'kernel.bin'),
                initrd: spec('agent.cpio', 'agent.cpio'),
                wasm: spec('v86.wasm', 'v86.wasm')
              },
              memoryBytes: 134217728,
              requiredKernelCapabilities: ['process'],
              supervisor: { protocolVersion: 1, execGateTimeoutMs: 30000 }
            }
          },
          environment: {
            allowedScopes: ['processTree'],
            defaultScope: 'processTree',
            capabilityBridge: { domains: [] }
          },
          executables: [{
            executableId: 'cat',
            executable: { kind: 'guestPath', path: '/bin/cat' },
            fixedArgs: [],
            shell: false
          }]
        }
      }
    }),
    { mode: 0o600 }
  )
  await copyFile(new URL('./v86-configure.sh', import.meta.url), join(bundle, 'configure-v86.sh'))
  await chmod(join(bundle, 'configure-v86.sh'), 0o755)
  await copyFile(new URL('./v86-cat-example.mjs', import.meta.url), join(bundle, 'cat-example.mjs'))
  return paths
}

// This is a private packaging check, not a public Process conformance claim.
export const verifyNativeV86Cat = async ({ bundle, executable, run }) => {
  const paths = {
    host: join(bundle, 'private/host-cat.json'),
    profiles: join(bundle, 'private/process-profiles.json'),
    backends: join(bundle, 'private/process-backends.json')
  }
  run('/bin/sh', ['./configure-v86.sh'], bundle)
  const stdout = run(
    executable,
    [
      '--timeout',
      '60000',
      '--host-config',
      paths.host,
      '--process-profiles',
      paths.profiles,
      '--process-backends',
      paths.backends,
      '--experimental-v86-process',
      './cat-example.mjs'
    ],
    bundle,
    90_000
  )
  if (stdout !== 'V86_NATIVE_PROCESS_OK\n') throw new Error('Relocated native v86 cat smoke failed')
  return stdout
}
