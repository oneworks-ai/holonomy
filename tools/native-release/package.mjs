import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { createNativeArchive } from './archive.mjs'

import { NATIVE_BUNDLE_DOCUMENTS, NATIVE_DEVELOPMENT_INSTRUCTIONS } from './documents.mjs'
import { verifyNativeEngineGates } from './engine-gate-smoke.mjs'
import { createManifest, describeFile, readBuildInputs, validateEngineInfo } from './manifest.mjs'
import { prepareNativeProvenance, verifyNativeProvenance } from './provenance.mjs'
import { publishPreparedArtifact } from './publication.mjs'
import { readOwnedFile, readPinnedV86Assets } from './v86-assets.mjs'
import { prepareNativeV86Bundle } from './v86-bundle.mjs'
import { verifyNativeV86Cat } from './v86-smoke.mjs'

const run = (binary, args, cwd, timeout = 20_000) => {
  const result = spawnSync(binary, args, {
    cwd,
    env: { PATH: '' },
    encoding: 'utf8',
    timeout,
    maxBuffer: 256 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Native artifact verification failed: ${result.error?.code ?? result.status}`)
  }
  return result.stdout
}
const json = value => `${JSON.stringify(value, null, 2)}\n`
export const packageNativeRuntime = async ({
  root,
  binary,
  output,
  v86Assets = null,
  v86Pins = null,
  v86CatSmoke = false
}) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Native artifact execution verification requires macOS arm64')
  }
  if ((v86Assets == null) !== (v86Pins == null) || (v86CatSmoke && v86Assets == null)) {
    throw new Error('Optional v86 packaging requires both --v86-assets and --v86-pins')
  }
  if (v86Assets != null && !v86CatSmoke) {
    throw new Error('Optional v86 packaging requires a real --v86-cat-smoke verification')
  }
  const build = await readBuildInputs(root)
  const v86 = v86Assets == null ? null : await readPinnedV86Assets({
    root: v86Assets,
    pinsFile: v86Pins,
    sourceRoot: root
  })
  const pinnedBinary = v86 == null ? null : await readOwnedFile(binary, { maximum: 512 * 1024 * 1024 })
  const source = pinnedBinary?.description ?? await describeFile(binary)
  const destination = resolve(output)
  await mkdir(destination) // Exclusive: do not overwrite or clean up a pre-existing user directory.
  let staging
  try {
    staging = await mkdtemp(join(destination, '.stage-'))
    const name = `holo-${build.version}-aarch64-apple-darwin${v86 == null ? '' : '-experimental-v86'}`
    const bundle = join(staging, name)
    await mkdir(join(bundle, 'bin'), { recursive: true })
    const executable = join(bundle, 'bin/holo')
    if (pinnedBinary == null) await copyFile(binary, executable)
    else await writeFile(executable, pinnedBinary.buffer)
    await chmod(executable, 0o755)
    if ((await describeFile(executable)).sha256 !== source.sha256) throw new Error('Binary changed while packaging')
    const engine = validateEngineInfo(
      JSON.parse(run(executable, ['engine', 'info', '--json'], staging)),
      build.expected,
      { v86BackendCompiled: v86 != null }
    )
    if (run(executable, ['--version'], staging).trim() !== `holo ${build.version} (V8 ${engine.v8})`) {
      throw new Error('Binary/package version mismatch')
    }
    for (const [to, from] of Object.entries(NATIVE_BUNDLE_DOCUMENTS)) {
      await copyFile(join(root, from), join(bundle, to))
    }
    await writeFile(
      join(bundle, 'DEVELOPMENT.md'),
      v86 == null
        ? NATIVE_DEVELOPMENT_INSTRUCTIONS
        : `${NATIVE_DEVELOPMENT_INSTRUCTIONS}\nSee V86-EXPERIMENTAL.md for the private Process setup and support boundary.\n`
    )
    const v86Files = v86 == null ? [] : await prepareNativeV86Bundle({ bundle, v86 })
    const provenance = await prepareNativeProvenance({
      root,
      bundle,
      build,
      engine,
      binary: source,
      v86,
      resolvedNotices: true
    })
    const files = {}
    for (
      const path of [
        'bin/holo',
        'DEVELOPMENT.md',
        ...Object.keys(NATIVE_BUNDLE_DOCUMENTS),
        ...v86Files,
        ...provenance.files
      ]
    ) {
      files[path] = await describeFile(join(bundle, path))
    }
    const manifest = createManifest({
      ...build,
      engine,
      files,
      provenance: provenance.summary,
      v86: v86?.manifest,
      v86CatSmoke
    })
    await writeFile(join(bundle, 'manifest.json'), json(manifest))
    const archive = `${name}.tar.gz`
    const prepared = join(staging, 'prepared')
    await mkdir(prepared)
    await createNativeArchive({ bundle, manifest, archive: join(prepared, archive) })
    // Exercise the delivered bytes after extraction, not the build-tree executable.
    const unpacked = await mkdtemp(join(staging, 'verify-'))
    run('/usr/bin/tar', ['-xzf', join(prepared, archive), '-C', unpacked], staging)
    const verifiedProvenance = await verifyNativeProvenance({ bundle: join(unpacked, name), manifest })
    const delivered = join(unpacked, name, 'bin/holo')
    if ((await describeFile(delivered)).sha256 !== source.sha256) throw new Error('Archive binary hash mismatch')
    if (v86 != null) {
      for (const [asset, input] of Object.entries(v86.files)) {
        const path = join(unpacked, name, 'private/v86-assets', asset)
        if ((await describeFile(path)).sha256 !== input.description.sha256) {
          throw new Error(`Archive v86 asset hash mismatch: ${asset}`)
        }
      }
    }
    const program = v86 == null ? join(unpacked, 'index.mjs') : './index.js'
    if (v86 == null) {
      await writeFile(
        program,
        "import assert from 'node:assert/strict';\nassert.equal(process.versions.node,undefined);\nawait new Promise(resolve=>setTimeout(resolve,1));\nconsole.log('HOLO_NATIVE_ARTIFACT_OK');\n"
      )
    }
    if (
      run(
        delivered,
        v86 == null ? ['--timeout', '3000', program] : [program],
        v86 == null ? unpacked : join(unpacked, name)
      ) !== 'HOLO_NATIVE_ARTIFACT_OK\n'
    ) {
      throw new Error('Relocated native smoke failed')
    }
    const engineGates = await verifyNativeEngineGates({
      directory: join(unpacked, 'engine-gate-smoke'),
      executable: delivered,
      run
    })
    const cat = v86CatSmoke
      ? await verifyNativeV86Cat({
        bundle: join(unpacked, name),
        executable: delivered,
        run
      })
      : null
    await writeFile(join(prepared, 'manifest.json'), json(manifest))
    await writeFile(
      join(prepared, 'verification.json'),
      json({
        schemaVersion: 1,
        status: 'passed',
        target: manifest.target,
        binarySha256: source.sha256,
        command: v86 == null ? 'holo --timeout 3000 index.mjs' : 'holo ./index.js',
        environment: { PATH: '' },
        stdout: 'HOLO_NATIVE_ARTIFACT_OK\n',
        engineGates,
        provenance: { status: 'verified', ...verifiedProvenance },
        ...(v86 == null ? {} : {
          experimentalV86: {
            compiled: true,
            catSmoke: cat == null ? 'not_run' : 'passed',
            ...(cat == null ? {} : { stdout: cat })
          }
        })
      })
    )
    const checksums = []
    for (const path of [archive, 'manifest.json', 'verification.json']) {
      checksums.push(`${(await describeFile(join(prepared, path))).sha256}  ${path}`)
    }
    await writeFile(join(prepared, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
    await publishPreparedArtifact(prepared, destination, archive)
    return {
      archive: join(destination, archive),
      manifest: join(destination, 'manifest.json'),
      verification: join(destination, 'verification.json'),
      sha256: (await describeFile(join(destination, archive))).sha256
    }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}
