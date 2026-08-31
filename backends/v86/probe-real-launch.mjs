import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const loadV86ProbeArtifactsV1 = async ({ biosPath, initrdPath, kernelPath, modulePath, wasmPath }) => {
  const { V86 } = await import(pathToFileURL(modulePath).href)
  const values = new Map(
    await Promise.all(
      [
        ['wasm', wasmPath],
        ['bios', biosPath],
        ['kernel', kernelPath],
        ['initrd', initrdPath]
      ].map(async ([artifactId, filePath]) => [artifactId, await readFile(filePath)])
    )
  )
  const artifact = artifactId => ({
    artifactId,
    sha256: createHash('sha256').update(values.get(artifactId)).digest('hex')
  })
  return Object.freeze({ artifact, V86, values })
}

export const createV86ProbeLaunchV1 =
  ({ backend, configuration, policy }) => (resourceId, executablePath, runtimeArgs) =>
    backend.spawn(
      backend.prepareLaunch({
        configuration,
        environmentScope: 'processTree',
        executable: backend.normalizeExecutable({ kind: 'guestPath', path: executablePath }),
        executableId: resourceId,
        executables: [
          {
            executable: { kind: 'guestPath', path: executablePath },
            executableId: resourceId,
            fixedArgs: [],
            shell: false
          },
          {
            executable: { kind: 'guestPath', path: '/usr/bin/holo-v86-invalid-executable' },
            executableId: 'v86-invalid-executable',
            fixedArgs: [],
            shell: false
          }
        ],
        generation: 1,
        policy,
        runtimeArgs
      }),
      { cwd: '/', env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] },
      { processResourceId: resourceId }
    )
