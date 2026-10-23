/* eslint-disable test/no-import-node-test -- Native CLI driver; public assertions execute in Guest JS. */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { createNativeV86PublicFixture } from './v86_public_fixture.mjs'

const workload = new URL('../../../conformance/capabilities/process-filesystem-native.test.mjs', import.meta.url)
const executables = [
  ['busybox', '/bin/busybox'],
  ['cat', '/bin/cat'],
  ['cp', '/bin/cp'],
  ['dd', '/bin/dd'],
  ['mkdir', '/bin/mkdir'],
  ['ls', '/bin/ls'],
  ['mv', '/bin/mv'],
  ['rm', '/bin/rm'],
  ['sh', '/bin/sh'],
  ['touch', '/bin/touch'],
  ['git', '/usr/bin/git']
].map(([executableId, path]) => ({ executableId, path }))

const processPolicy = readOnly => ({
  access: 'sandboxed',
  environment: { allowedNames: [], maxValueBytes: 1024 },
  executables: executables.map(({ executableId }) => ({ executableId, argumentBytes: 4096 })),
  shell: { access: 'none' },
  mounts: [{ rootId: 'workspace', guestPath: '/workspace', rights: readOnly ? ['read'] : ['read', 'write'] }],
  network: { access: 'none' },
  limits: {
    maxConcurrentProcesses: 1,
    maxTotalProcesses: 24,
    maxProcessTreeDepth: 1,
    maxExecutionTimeMs: 30_000,
    maxStdinBytes: 4096,
    maxStdoutBytes: 16_384,
    maxStderrBytes: 16_384,
    maxOpenPipes: 3,
    maxWritableRootfsBytes: 0
  }
})

const hostConfig = readOnly => ({
  plugins: [{ id: 'filesystem-sync-authority', use: './sync-policy.mjs' }],
  filesystemRoots: [{ rootId: 'workspace', hostPath: './data' }],
  sandboxPolicy: {
    schemaVersion: 2,
    process: processPolicy(readOnly),
    filesystem: {
      access: 'sandboxed',
      roots: [{
        rootId: 'workspace',
        virtualUrl: 'holo-fs://workspace/',
        symlinks: 'deny',
        rights: readOnly ? ['read', 'list'] : ['read', 'write', 'create', 'list', 'move', 'delete', 'chmod']
      }],
      limits: {
        maxReadBytes: 1_048_576,
        maxWriteBytes: 1_048_576,
        maxOpenHandles: 32,
        maxWatchers: 0,
        maxDirectoryEntries: 128,
        maxQueuedEvents: 0
      }
    }
  }
})

const guestReport = result =>
  result.stdout.split('\n').map(line => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).find(value => Array.isArray(value?.results))

test('pinned Native v86 Linux tools use the public Process and filesystem bridge', {
  timeout: 260_000
}, async t => {
  for (const readOnly of [false, true]) {
    const fixture = await createNativeV86PublicFixture({
      testContext: t,
      prefix: 'holo-v86-filesystem-public-',
      executables,
      hostConfig: hostConfig(readOnly),
      requiredKernelCapabilities: ['process', 'fuse']
    })
    try {
      const data = join(fixture.root, 'data')
      await mkdir(data)
      await writeFile(join(data, 'source.txt'), 'SOURCE_CONTENT\n')
      for (
        const [name, contents] of [
          ['a b.txt', 'SPACE\n'],
          ['中😀.txt', 'UNICODE\n'],
          ['%2F.txt', 'LITERAL_PERCENT\n']
        ]
      ) await writeFile(join(data, name), contents)
      await fixture.write(
        'sync-policy.mjs',
        `export default ctx => {
        ctx.holo.intercept({operation:'filesystem.directory.sync'},(request,next)=> {
          if(request.resource.requested.pathSegments.includes('blocked-sync')) return ctx.holo.deny(request);
          return next();
        },{execution:'sync'});
      };`
      )
      if (!readOnly) {
        await mkdir(join(data, 'listing'))
        await mkdir(join(data, 'blocked-sync'))
        await writeFile(join(data, 'listing', 'a.txt'), 'A')
        await writeFile(join(data, 'listing', 'b.txt'), 'B')
        await writeFile(join(data, 'target.txt'), 'OLD_LONGER_CONTENT_MUST_BE_TRUNCATED\n')
        await writeFile(join(data, 'flag-target.txt'), 'PRESERVED_SUFFIX\n')
        await writeFile(join(data, 'append-target.txt'), 'PREFIX')
        await writeFile(join(data, 'touch-target.txt'), 'TOUCH_MUST_PRESERVE\n')
      }
      await fixture.write('workload.mjs', await readFile(workload))
      await fixture.write(
        'filesystem.test.mjs',
        `import { registerNativeProcessFilesystemTests } from './workload.mjs';
         registerNativeProcessFilesystemTests({ readOnly: ${readOnly} });`
      )
      const result = await fixture.run('filesystem.test.mjs', { timeoutMs: 120_000 })
      t.diagnostic(JSON.stringify({ readOnly, result }))
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.equal(result.signal, null)
      const report = guestReport(result)
      assert(report, result.stdout + result.stderr)
      assert.equal(report.total, readOnly ? 3 : 9, result.stdout + result.stderr)
      assert.equal(report.passed, report.total, result.stdout + result.stderr)
      assert.equal(report.failed, 0)
      assert.equal(report.skipped, 0)
      assert.equal(await readFile(join(data, 'source.txt'), 'utf8'), 'SOURCE_CONTENT\n')
      if (readOnly) assert.equal((await readdir(data)).includes('denied.txt'), false)
      else {
        assert.equal((await readdir(data)).includes('target.txt'), false)
        assert.deepEqual(await readdir(join(data, 'sub')), [])
        const repository = join(data, 'git-probe', '.git')
        assert.match(await readFile(join(repository, 'HEAD'), 'utf8'), /^ref: refs\/heads\/\S+\n$/u)
        const config = await readFile(join(repository, 'config'), 'utf8')
        assert.match(config, /^\[core\]$/mu)
        assert.match(config, /^\s*repositoryformatversion\s*=\s*0$/mu)
        assert.match(config, /^\s*bare\s*=\s*false$/mu)
        assert((await readdir(repository)).includes('objects'))
        t.diagnostic(JSON.stringify({ gitHostReadback: { head: true, config: true, objects: true } }))
      }
    } finally {
      await fixture.dispose()
    }
  }
})

test('one Linux process reuses a single Host file/directory handle slot before VM exit', {
  timeout: 115_000
}, async t => {
  const config = hostConfig(true)
  config.plugins = []
  config.sandboxPolicy.process.executables = [{ executableId: 'sh', argumentBytes: 4096 }]
  config.sandboxPolicy.process.limits.maxTotalProcesses = 1
  config.sandboxPolicy.filesystem.limits.maxOpenHandles = 1
  config.sandboxPolicy.filesystem.limits.maxDirectoryEntries = 16
  const fixture = await createNativeV86PublicFixture({
    testContext: t,
    prefix: 'holo-v86-filesystem-release-',
    executables: [{ executableId: 'sh', path: '/bin/sh' }],
    hostConfig: config,
    requiredKernelCapabilities: ['process', 'fuse']
  })
  try {
    const data = join(fixture.root, 'data')
    await mkdir(join(data, 'listing'), { recursive: true })
    await writeFile(join(data, 'source.txt'), 'SOURCE_CONTENT\n')
    for (const name of ['a.txt', 'b.txt']) await writeFile(join(data, 'listing', name), name)
    await fixture.write('workload.mjs', await readFile(workload))
    await fixture.write(
      'release.test.mjs',
      `import { registerNativeProcessFilesystemReleaseTests } from './workload.mjs';
       registerNativeProcessFilesystemReleaseTests();`
    )
    const result = await fixture.run('release.test.mjs', { timeoutMs: 100_000 })
    t.diagnostic(JSON.stringify({ releaseProof: true, result }))
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(result.signal, null)
    const report = guestReport(result)
    assert.equal(report?.total, 1, result.stdout + result.stderr)
    assert.equal(report.passed, 1)
    assert.equal(report.failed, 0)
    assert.equal(report.skipped, 0)
  } finally {
    await fixture.dispose()
  }
})
