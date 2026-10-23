import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { createArtifactArchive } from '../artifact-archive/archive.mjs'
import { describeFile, readArtifactFile, sha256 } from '../artifact-archive/files.mjs'
import { publishPreparedArtifact } from '../artifact-archive/publication.mjs'
import { verifyAarEnvelope, verifyRuntimeAar } from './aar.mjs'
import { SDK_MODULES, SDK_SOURCE_FILES, sdkLibraryPath, sdkReadme } from './files.mjs'
import { SDK_MAX_BYTES, sdkJson, verificationRecord, verifySdkArchive } from './inventory.mjs'

export const androidSdkRepositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const build = root => {
  const run = (command, args, cwd) => {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout: 30 * 60_000 })
    if (result.error || result.status !== 0) throw new Error('Android SDK build failed')
  }
  run(process.execPath, [join(root, 'tools/build-workspace.mjs')], root)
  run(
    join(root, 'adapters/android/gradlew'),
    ['--no-daemon', ...SDK_MODULES.map(module => `:${module}:assembleDebug`)],
    join(root, 'adapters/android')
  )
}

const assertNewOutput = async output => {
  try {
    await lstat(output)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error('Android SDK output already exists')
}

export const packageAndroidSdk = async ({ root = androidSdkRepositoryRoot, output, skipBuild = false } = {}) => {
  if (!['darwin', 'linux'].includes(process.platform) || typeof output !== 'string' || output.length === 0) {
    throw new Error('Android SDK packaging requires macOS/Linux and a new output directory')
  }
  root = resolve(root)
  output = resolve(output)
  await assertNewOutput(output)
  const sourcePackage = JSON.parse((await readArtifactFile(join(root, 'package.json'), 1024 * 1024)).toString('utf8'))
  const version = sourcePackage.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)) {
    throw new Error('Invalid SDK version')
  }
  if (typeof skipBuild !== 'boolean') throw new Error('Invalid SDK build option')
  if (!skipBuild) build(root)
  const input = new Map()
  const add = (path, bytes) => input.set(path, bytes)
  for (const [destination, source] of Object.entries(SDK_SOURCE_FILES)) {
    add(destination, await readArtifactFile(join(root, source), 8 * 1024 * 1024))
  }
  for (const module of SDK_MODULES) {
    add(
      sdkLibraryPath(module),
      await readArtifactFile(
        join(root, 'adapters/android', module, 'build/outputs/aar', `${module}-debug.aar`),
        32 * 1024 * 1024
      )
    )
  }
  add('README.md', Buffer.from(sdkReadme(false)))
  add('README.zh-Hans.md', Buffer.from(sdkReadme(true)))
  if ([...input.values()].reduce((total, bytes) => total + bytes.length, 0) > 64 * 1024 * 1024) {
    throw new Error('Android SDK inputs exceed the aggregate limit')
  }
  const buildInputs = {}
  for (const path of ['package.json', 'pnpm-lock.yaml', 'adapters/android/build.gradle.kts']) {
    buildInputs[path] = await describeFile(join(root, path))
  }
  await mkdir(output, { mode: 0o700 })
  const staging = await mkdtemp(join(output, '.stage-'))
  try {
    const name = `holo-android-sdk-${version}-development`
    const bundle = join(staging, name)
    const prepared = join(staging, 'prepared')
    await mkdir(bundle)
    await mkdir(prepared)
    const files = {}
    for (const [path, bytes] of [...input].sort(([a], [b]) => a < b ? -1 : 1)) {
      await mkdir(dirname(join(bundle, path)), { recursive: true })
      await writeFile(join(bundle, path), bytes, { flag: 'wx' })
      files[path] = { bytes: bytes.length, sha256: sha256(bytes) }
    }
    for (const module of SDK_MODULES) verifyAarEnvelope(input.get(sdkLibraryPath(module)))
    const bootstrap = await readArtifactFile(
      join(root, 'adapters/android/runtime-host/src/runtimeBootstrap/bootstrap.mjs'),
      1024 * 1024
    )
    const runtimeAssets = verifyRuntimeAar(input.get(sdkLibraryPath('runtime-host')), bootstrap)
    const manifest = {
      schemaVersion: 1,
      product: 'holonomy-android-sdk',
      version,
      distribution: 'local-development-sdk',
      publishReady: false,
      signed: false,
      physicalDeviceAccepted: false,
      minSdk: 29,
      abis: ['arm64-v8a', 'x86_64'],
      sourceBuild: {
        executed: !skipBuild,
        jdk: 17,
        sdk: 35,
        ndk: '27.2.12479018',
        cmake: '3.22.1',
        testsExecuted: false
      },
      dependencies: { javet: '5.0.10', kotlin: '2.0.21', optionalSessionGson: '2.10.1', bundled: false },
      consumer: { aarModules: ['host-core', 'v8-host', 'runtime-host', 'crypto-host'], expectedJsCases: 6 },
      buildInputs,
      runtimeAssets,
      files
    }
    const manifestBytes = sdkJson(manifest)
    await writeFile(join(bundle, 'manifest.json'), manifestBytes, { flag: 'wx' })
    const archive = `${name}.tar.gz`
    await createArtifactArchive({
      bundle,
      manifest,
      archive: join(prepared, archive),
      executablePaths: ['consumer/gradlew']
    })
    const archiveBytes = await readArtifactFile(join(prepared, archive), SDK_MAX_BYTES)
    const verified = verifySdkArchive(archiveBytes, manifestBytes)
    await writeFile(join(prepared, 'manifest.json'), manifestBytes, { flag: 'wx' })
    const verification = verificationRecord(archiveBytes, manifestBytes, verified)
    await writeFile(
      join(prepared, 'SHA256SUMS'),
      `${sha256(archiveBytes)}  ${archive}\n${sha256(manifestBytes)}  manifest.json\n`,
      { flag: 'wx' }
    )
    await writeFile(join(prepared, 'verification.json'), sdkJson(verification), { flag: 'wx' })
    await publishPreparedArtifact(prepared, output, archive)
    return { output, archiveFile: archive, ...verification }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export const verifyAndroidSdk = async output => {
  output = resolve(output)
  const directory = await lstat(output)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('SDK output must be a real directory')
  const marker = JSON.parse((await readArtifactFile(join(output, 'verification.json'), 256 * 1024)).toString('utf8'))
  const manifestBytes = await readArtifactFile(join(output, 'manifest.json'), 2 * 1024 * 1024)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version)) throw new Error('Invalid SDK version')
  const archive = `holo-android-sdk-${manifest.version}-development.tar.gz`
  const archiveBytes = await readArtifactFile(join(output, archive), SDK_MAX_BYTES)
  const verified = verifySdkArchive(archiveBytes, manifestBytes)
  const expected = verificationRecord(archiveBytes, manifestBytes, verified)
  if (JSON.stringify(marker) !== JSON.stringify(expected)) throw new Error('Android SDK completion marker mismatch')
  const sums = `${sha256(archiveBytes)}  ${archive}\n${sha256(manifestBytes)}  manifest.json\n`
  if ((await readArtifactFile(join(output, 'SHA256SUMS'), 256 * 1024)).toString('utf8') !== sums) {
    throw new Error('Android SDK checksum list mismatch')
  }
  return { output, archiveFile: archive, ...expected }
}
