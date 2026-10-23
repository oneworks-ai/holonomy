import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import { admitLaunchSnapshot } from '../launch-admission.mjs'
import { materializeNativeLaunch, validateNativeLaunchGraph } from '../native-launch-materialization.mjs'
import { privateLaunchLine } from '../native-target-adapter.mjs'
import { validateServiceRequest } from '../request-schemas.mjs'

const root = 'app://workspace/'
const entryUrl = `${root}run.mjs`
const graph = () => ({
  argv: [entryUrl],
  entryUrl,
  moduleRootUrl: root,
  modules: [
    { source: 'import "app://workspace/main.mjs"', url: entryUrl },
    { source: 'console.log("safe")', url: `${root}main.mjs` }
  ],
  schemaVersion: 2,
  target: 'native'
})

describe('native launch graph admission', () => {
  it('uses locale-independent metadata digest ordering and preserves the legacy empty frame', () => {
    const input = graph()
    const legacy = createHash('sha256')
    for (const module of input.modules) {
      legacy.update(module.url).update('\0').update(String(Buffer.byteLength(module.source)))
        .update('\0').update(module.source).update('\0')
    }
    assert.equal(validateNativeLaunchGraph(input).digest, legacy.digest('hex'))
    input.modules.push(
      { metadataOnly: true, source: '{}', url: `${root}a/package.json` },
      { metadataOnly: true, source: '{}', url: `${root}B/package.json` }
    )
    const expected = createHash('sha256')
    for (const module of input.modules) {
      expected.update(module.url).update('\0').update(String(Buffer.byteLength(module.source)))
        .update('\0').update(module.source).update('\0')
    }
    expected.update('metadata-only-v1\0').update(`${root}B/package.json\0`).update(`${root}a/package.json\0`)
    const admitted = validateNativeLaunchGraph(input)
    assert.deepEqual(admitted.moduleMetadataOnly, [`${root}B/package.json`, `${root}a/package.json`])
    assert.equal(admitted.digest, expected.digest('hex'))
  })

  it('binds metadata-only package manifests in the digest and private v4 launch', async () => {
    const input = graph()
    const manifestUrl = `${root}package.json`
    const manifestAlias = `${root}linked/package.json`
    const manifestSource = '{"type":"module","private":"host"}'
    input.modules.push({ metadataOnly: true, source: manifestSource, url: manifestUrl })
    input.moduleAliases = [{ canonicalUrl: manifestUrl, url: manifestAlias }]
    const prior = validateNativeLaunchGraph({
      ...input,
      modules: input.modules.map(module => ({ source: module.source, url: module.url }))
    })
    const admitted = validateNativeLaunchGraph(input)
    assert.notEqual(admitted.digest, prior.digest)
    assert.deepEqual(admitted.moduleMetadataOnly, [manifestUrl])
    assert(admitted.moduleAllowlist.includes(manifestUrl))
    assert(admitted.moduleAllowlist.includes(manifestAlias))
    const request = validateServiceRequest('ProcessStartRequest', {
      deviceId: 'native:local',
      entryUrl,
      inspectorMode: 'off',
      isolation: 'runtime',
      launch: input,
      target: 'native'
    })
    assert.equal(request.launch.modules.at(-1).metadataOnly, true)
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-metadata-stage-'))
    const process = {
      generation: 1,
      id: 'process_metadata_v4',
      launch: JSON.parse(JSON.stringify(admitLaunchSnapshot(request.launch, { entryUrl, target: 'native' })))
    }
    try {
      const staged = await materializeNativeLaunch(process, stateDirectory, undefined, () => {
        process.launch.modules.at(-1).metadataOnly = false
        process.launch.modules.at(-1).source = '{}'
      })
      const privateLaunch = JSON.parse(privateLaunchLine(process, staged))
      assert.equal(privateLaunch.schemaVersion, 4)
      assert.deepEqual(privateLaunch.moduleMetadataOnly, [manifestUrl])
      assert.deepEqual(privateLaunch.moduleAliases, [{ canonicalUrl: manifestUrl, url: manifestAlias }])
      assert.equal(await readFile(join(staged.workspaceRoot, 'package.json'), 'utf8'), manifestSource)
      assert.equal(privateLaunch.moduleAllowlist.includes(manifestUrl), true)
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  it('rejects malformed metadata markers and canonical path collisions', () => {
    for (
      const badUrl of [
        `${root}config.json`,
        `${root}package.json?raw`,
        `${root}package.json#`,
        `${root}node_modules/pkg/manifest.json`
      ]
    ) {
      const input = graph()
      input.modules.push({ metadataOnly: true, source: '{}', url: badUrl })
      assert.throws(() => validateNativeLaunchGraph(input), error => error.code === 'service.invalid_request')
    }
    for (const value of [false, null, 'true', 1]) {
      const input = graph()
      input.modules.push({ metadataOnly: value, source: '{}', url: `${root}package.json` })
      assert.throws(() => validateNativeLaunchGraph(input), error => error.code === 'service.invalid_request')
      assert.throws(() =>
        validateServiceRequest('ProcessStartRequest', {
          deviceId: 'native:local',
          entryUrl,
          inspectorMode: 'off',
          isolation: 'runtime',
          launch: input,
          target: 'native'
        }), error => error.code === 'service.invalid_request')
    }
    const unknown = graph()
    unknown.modules[0].extra = true
    assert.throws(() => validateNativeLaunchGraph(unknown))
    const conflict = graph()
    conflict.modules.push({ metadataOnly: true, source: '{}', url: `${root}package.json` })
    conflict.modules.push({ source: '{}', url: `${root}package.json?same-bytes` })
    assert.throws(() => validateNativeLaunchGraph(conflict), error => error.code === 'service.invalid_request')
    const renamedAlias = graph()
    renamedAlias.modules.push({ metadataOnly: true, source: '{}', url: `${root}package.json` })
    renamedAlias.moduleAliases = [{ canonicalUrl: `${root}package.json`, url: `${root}raw.json` }]
    assert.throws(() => validateNativeLaunchGraph(renamedAlias), error => error.code === 'service.invalid_request')
    const restrictedEntry = graph()
    restrictedEntry.entryUrl = `${root}package.json`
    restrictedEntry.argv = [restrictedEntry.entryUrl]
    restrictedEntry.modules.push({ metadataOnly: true, source: '{}', url: restrictedEntry.entryUrl })
    assert.throws(() => validateNativeLaunchGraph(restrictedEntry), error => error.code === 'service.invalid_request')
  })

  it('rejects metadata-only markers for Node and Android launches', () => {
    for (const target of ['node', 'android']) {
      const input = graph()
      input.target = target
      input.modules[0].metadataOnly = true
      assert.throws(
        () => admitLaunchSnapshot(input, { entryUrl, target }),
        error => error.code === 'service.invalid_request'
      )
    }
  })

  it('binds exact logical URLs before writing any source', () => {
    const admitted = validateNativeLaunchGraph(graph())
    assert.match(admitted.digest, /^[0-9a-f]{64}$/u)
    assert.equal(admitted.moduleCount, 2)
    for (
      const url of [
        'app://workspace/../host/host.json',
        'app://workspace/%2fhost/host.json',
        'app://workspace/%6dain.mjs',
        'app://other/run.mjs',
        'app://workspace/run.mjs?changed=1'
      ]
    ) {
      const input = graph()
      input.modules[1].url = url
      assert.throws(() => validateNativeLaunchGraph(input), error => error.code === 'service.invalid_request')
    }
    const duplicate = graph()
    duplicate.modules[1].url = 'app://workspace/RUN.mjs'
    assert.throws(() => validateNativeLaunchGraph(duplicate))
    const missing = graph()
    missing.modules.shift()
    assert.throws(() => validateNativeLaunchGraph(missing))
    const wrongRoot = graph()
    wrongRoot.moduleRootUrl = 'app+local://workspace/'
    assert.throws(() => validateNativeLaunchGraph(wrongRoot))
    const ordinaryEncoded = graph()
    ordinaryEncoded.modules[1].url = 'app://workspace/%E4%BE%8B%20@.mjs'
    assert.equal(validateNativeLaunchGraph(ordinaryEncoded).moduleCount, 2)
    const oversizedArgv = graph()
    oversizedArgv.argv.push(...Array.from({ length: 17 }, () => 'x'.repeat(16_384)))
    assert.throws(() => validateNativeLaunchGraph(oversizedArgv))
    const nulArgv = graph()
    nulArgv.argv.push('bad\0argument')
    assert.throws(() => validateNativeLaunchGraph(nulArgv))
  })

  it('admits a flat pnpm alias, preserves query identity, and binds the digest and allowlist', () => {
    const input = graph()
    const requested = `${root}node_modules/pkg/index.mjs?case=one`
    const canonical = `${root}node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs?case=one`
    input.modules.push({ source: 'export default 1', url: canonical })
    input.moduleAliases = [{ url: requested, canonicalUrl: canonical }]
    const admitted = validateNativeLaunchGraph(input)
    assert.equal(admitted.moduleCount, 3)
    assert.deepEqual(admitted.moduleAliases, input.moduleAliases)
    assert(admitted.moduleAllowlist.includes(requested))
    assert(admitted.moduleAllowlist.includes(canonical))
    assert.notEqual(admitted.digest, validateNativeLaunchGraph({ ...input, moduleAliases: [] }).digest)
    const emptyFragment = graph()
    emptyFragment.modules.push({ source: 'export default 1', url: `${canonical}#` })
    emptyFragment.moduleAliases = [{ url: `${requested}#`, canonicalUrl: `${canonical}#` }]
    assert.equal(validateNativeLaunchGraph(emptyFragment).moduleAliases[0].url, `${requested}#`)
    input.moduleAliases[0].canonicalUrl = `${root}main.mjs`
    assert.equal(admitted.moduleAliases[0].canonicalUrl, canonical)
  })

  it('rejects malformed, chained, conflicting, duplicate, and oversized aliases', () => {
    const canonical = `${root}node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs?case=one`
    const requested = `${root}node_modules/pkg/index.mjs?case=one`
    const base = () => {
      const input = graph()
      input.modules.push({ source: 'export default 1', url: canonical })
      input.moduleAliases = [{ url: requested, canonicalUrl: canonical }]
      return input
    }
    for (
      const change of [
        alias => alias.url = 'app://other/pkg/index.mjs?case=one',
        alias => alias.url = `${root}%2e%2e/host/secret.mjs?case=one`,
        alias => alias.url = `${root}node_modules/%2fpkg/index.mjs?case=one`,
        alias => alias.url = `${requested}#fragment`,
        alias => alias.canonicalUrl = `${root}missing.mjs?case=one`,
        alias => alias.canonicalUrl = `${root}main.mjs`,
        alias => alias.url = `${requested}#`,
        alias => alias.extra = true
      ]
    ) {
      const input = base()
      change(input.moduleAliases[0])
      assert.throws(() => validateNativeLaunchGraph(input), error => error.code === 'service.invalid_request')
    }
    const chained = base()
    chained.moduleAliases.push({ url: `${root}other.mjs?case=one`, canonicalUrl: requested })
    assert.throws(() => validateNativeLaunchGraph(chained))
    const duplicate = base()
    duplicate.moduleAliases.push({ ...duplicate.moduleAliases[0] })
    assert.throws(() => validateNativeLaunchGraph(duplicate))
    const conflict = base()
    conflict.modules.push({ source: 'different bytes', url: requested.slice(0, requested.indexOf('?')) })
    assert.throws(() => validateNativeLaunchGraph(conflict))
    const tooMany = base()
    tooMany.moduleAliases = Array.from({ length: 513 }, (_, index) => ({
      canonicalUrl: canonical,
      url: `${root}alias-${index}.mjs?case=one`
    }))
    assert.throws(() => validateNativeLaunchGraph(tooMany))
    const tooManyBytes = base()
    tooManyBytes.moduleAliases = Array.from({ length: 440 }, (_, index) => ({
      canonicalUrl: canonical,
      url: `${root}alias-${index}-${'x'.repeat(600)}.mjs?case=one`
    }))
    assert.throws(() => validateNativeLaunchGraph(tooManyBytes))
  })

  it('stages only canonical files and retains validated aliases after input mutation', async () => {
    const input = graph()
    const canonical = `${root}node_modules/.pnpm/pkg@1/node_modules/pkg/index.mjs`
    const requested = `${root}node_modules/pkg/index.mjs`
    input.modules.push({ source: 'export default 1', url: canonical })
    input.moduleAliases = [{ url: requested, canonicalUrl: canonical }]
    const process = { generation: 1, id: 'process_alias_copy', launch: input }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-alias-stage-'))
    try {
      const staged = await materializeNativeLaunch(process, stateDirectory, undefined, () => {
        input.moduleAliases[0].canonicalUrl = `${root}main.mjs`
        input.moduleAliases.push({ url: `${root}bad.mjs`, canonicalUrl: `${root}main.mjs` })
      })
      assert.deepEqual(staged.moduleAliases, [{ url: requested, canonicalUrl: canonical }])
      assert.equal(staged.moduleAllowlist.includes(`${root}bad.mjs`), false)
      const privateLaunch = JSON.parse(privateLaunchLine(process, staged))
      assert.equal(privateLaunch.schemaVersion, 3)
      assert.equal(privateLaunch.workspaceRoot, staged.workspaceRoot)
      assert.deepEqual(privateLaunch.moduleAliases, [{ url: requested, canonicalUrl: canonical }])
      assert(privateLaunch.moduleAllowlist.includes(requested))
      assert(privateLaunch.moduleAllowlist.includes(canonical))
      assert.equal(
        await readFile(
          join(staged.workspaceRoot, 'node_modules', '.pnpm', 'pkg@1', 'node_modules', 'pkg', 'index.mjs'),
          'utf8'
        ),
        'export default 1'
      )
      await assert.rejects(stat(join(staged.workspaceRoot, 'node_modules', 'pkg', 'index.mjs')))
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  it('retains the v2 private launch for a graph without aliases', async () => {
    const process = { generation: 1, id: 'process_no_alias', launch: graph() }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-no-alias-stage-'))
    try {
      const staged = await materializeNativeLaunch(process, stateDirectory)
      const privateLaunch = JSON.parse(privateLaunchLine(process, staged))
      assert.equal(privateLaunch.schemaVersion, 2)
      assert.equal(Object.hasOwn(privateLaunch, 'moduleAliases'), false)
      assert.deepEqual(privateLaunch.moduleAllowlist, process.launch.modules.map(module => module.url))
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  it('pins the selected Process profile in a private generation manifest', async () => {
    const selected = {
      backend: { backendId: 'native.darwin-seatbelt-v1', configuration: {} },
      executables: [{ executable: { kind: 'hostPath', path: '/usr/bin/true' }, executableId: 'tool' }],
      profile: 'process-profile-v1'
    }
    const process = {
      capabilityRuntime: { policyDigest: 'digest', processProfileId: 'developer' },
      generation: 1,
      id: 'process_private_profile',
      launch: graph()
    }
    const capabilityRuntime = {
      policy: { filesystem: { access: 'none' }, process: { access: 'sandboxed' }, schemaVersion: 2 },
      policyDigest: 'digest',
      processProfile: selected,
      processProfileId: 'developer'
    }
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-profile-stage-'))
    try {
      const staged = await materializeNativeLaunch(process, stateDirectory, capabilityRuntime)
      const privateLaunch = JSON.parse(privateLaunchLine(process, staged))
      const hostConfig = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
      const manifest = JSON.parse(await readFile(staged.processProfilesManifest, 'utf8'))
      assert.equal(hostConfig.processProfileId, 'developer')
      assert.equal(Object.hasOwn(hostConfig, 'processProfile'), false)
      assert.deepEqual(manifest.profiles.developer, selected)
      assert.equal((await stat(staged.processProfilesManifest)).mode & 0o777, 0o600)
      assert.equal(privateLaunch.processProfilesManifest, staged.processProfilesManifest)
      assert.equal(JSON.stringify(privateLaunch.hostConfig).includes('/usr/bin/true'), false)
      await assert.rejects(
        materializeNativeLaunch(
          { ...process, capabilityRuntime: { ...process.capabilityRuntime, processProfileId: 'other' } },
          stateDirectory,
          capabilityRuntime
        ),
        error => error.code === 'service.precondition_failed'
      )
      await assert.rejects(
        materializeNativeLaunch(
          { ...process, id: 'process_oversized_profile' },
          stateDirectory,
          { ...capabilityRuntime, processProfile: { ...selected, filler: 'x'.repeat(1024 * 1024) } }
        ),
        error => error.code === 'service.limit_exceeded'
      )
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})

describe('native diagnostic audit staging', () => {
  const reader = Object.freeze({
    capabilityName: 'host.diagnostics.source.read',
    maxReadBytes: 64,
    maxReads: 2
  })
  const boundedPolicy = Object.freeze({
    diagnostics: { maxSourceReadBytes: 64, sourceReader: 'boundedSource' },
    schemaVersion: 2
  })
  const process = () => ({
    capabilityRuntime: { policyDigest: 'digest' },
    generation: 1,
    id: 'audit_process',
    launch: { ...graph(), command: 'test' }
  })
  const runtime = audit => ({
    diagnosticSourceReader: reader,
    ...(audit == null ? {} : { diagnosticAudit: audit }),
    policy: boundedPolicy,
    policyDigest: 'digest'
  })

  it('stages an owner-derived private path and forces profile-only test to read the Host config', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-audit-stage-'))
    try {
      const staged = await materializeNativeLaunch(process(), stateDirectory, runtime({ maxBytes: 1024 }))
      const host = JSON.parse(await readFile(staged.hostConfigPath, 'utf8'))
      assert.deepEqual(host.diagnosticAudit, {
        maxBytes: 1024,
        path: './audit/source-reads.jsonl'
      })
      assert.equal((await stat(join(staged.hostRoot, 'audit'))).mode & 0o777, 0o700)
      assert.equal((await stat(staged.hostConfigPath)).mode & 0o777, 0o600)
      const privateLaunch = JSON.parse(privateLaunchLine(process(), staged))
      assert.equal(privateLaunch.servicePluginConfig, staged.hostConfigPath)
      assert.equal(privateLaunch.watchConfig, null)
      assert.equal(JSON.stringify(privateLaunch).includes(`${stateDirectory}/audit`), false)
      assert.equal(JSON.stringify(privateLaunch).includes('source.read.admitted'), false)
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  it('preserves the unselected default and refuses forged private audit shape', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'holonomy-native-audit-stage-'))
    try {
      const plain = await materializeNativeLaunch(process(), stateDirectory, runtime(undefined))
      assert.equal(Object.hasOwn(plain.hostConfig, 'diagnosticAudit'), false)
      assert.equal(Object.hasOwn(JSON.parse(privateLaunchLine(process(), plain)), 'servicePluginConfig'), false)
      await assert.rejects(stat(join(plain.hostRoot, 'audit')), { code: 'ENOENT' })
      for (const value of [{ maxBytes: 1024, path: '/tmp/forged' }, { maxBytes: 1023 }, null]) {
        await assert.rejects(
          materializeNativeLaunch(
            { ...process(), id: `forged_${Math.random().toString(36).slice(2)}` },
            stateDirectory,
            { ...runtime(undefined), diagnosticAudit: value }
          ),
          error => error.code === 'service.precondition_failed'
        )
      }
      await assert.rejects(
        materializeNativeLaunch(
          { ...process(), id: 'audit_without_reader' },
          stateDirectory,
          { diagnosticAudit: { maxBytes: 1024 }, policy: boundedPolicy, policyDigest: 'digest' }
        ),
        error => error.code === 'service.precondition_failed'
      )
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
