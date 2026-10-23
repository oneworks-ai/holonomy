import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import nodeFs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line test/no-import-node-test -- Real Node Provider race boundary.
import test from 'node:test'

import { canonicalizeFilesystemResource } from '@holonomyjs/runtime/kernel'
import { NodeFilesystemProviderV1 } from '../src/capability-fs-provider.mjs'

const flag = {
  kind: 'portable-open-v1',
  access: 'write',
  create: true,
  exclusive: false,
  truncate: true,
  append: false
}

const authority = {
  bindings: [{
    providerModule: 'host.fs',
    constraints: {
      limits: { maxOpenHandles: 8 },
      roots: [{ rootId: 'workspace', pathPrefixSegments: [], rights: ['read', 'write'], symlinks: 'deny' }]
    }
  }],
  complete: (value, resources) => ({ value, resources })
}

const context = path => {
  const requested = canonicalizeFilesystemResource(`holo-fs://workspace/${path}`, path)
  return {
    arguments: { path: requested.semanticId, flag },
    member: 'open',
    module: 'node:fs/promises',
    operation: 'filesystem.file.open',
    resource: { requested },
    authorityBindings: authority.bindings,
    runtime: { generation: 1 },
    source: { kind: 'linuxProcess' }
  }
}

test('a leaf symlink swap after Provider verification cannot truncate an outside file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-open-leaf-race-'))
  let provider
  try {
    const inside = join(root, 'inside')
    const outside = join(root, 'outside')
    await writeFile(inside, 'INSIDE')
    await writeFile(outside, 'OUTSIDE_MUST_SURVIVE')
    provider = new NodeFilesystemProviderV1([{ rootId: 'workspace', hostPath: root }])
    const call = context('inside')
    const plan = provider.preflight(call, authority)
    plan.requests[0].verify()
    nodeFs.renameSync(inside, join(root, 'held'))
    nodeFs.symlinkSync(outside, inside)
    assert.throws(() => plan.execute(call, [authority]), { code: 'resource.cross_root' })
    assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_MUST_SURVIVE')
    assert.equal(await readFile(join(root, 'held'), 'utf8'), 'INSIDE')
  } finally {
    provider?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('an ancestor symlink swap after verification fails the fd walk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-open-ancestor-race-'))
  let provider
  try {
    const parent = join(root, 'parent')
    const outside = join(root, 'outside')
    nodeFs.mkdirSync(parent)
    nodeFs.mkdirSync(outside)
    await writeFile(join(parent, 'value'), 'INSIDE')
    await writeFile(join(outside, 'value'), 'OUTSIDE_MUST_SURVIVE')
    provider = new NodeFilesystemProviderV1([{ rootId: 'workspace', hostPath: root }])
    const call = context('parent/value')
    const plan = provider.preflight(call, authority)
    plan.requests[0].verify()
    nodeFs.renameSync(parent, join(root, 'held'))
    nodeFs.symlinkSync(outside, parent)
    assert.throws(() => plan.execute(call, [authority]), { code: 'resource.cross_root' })
    assert.equal(await readFile(join(outside, 'value'), 'utf8'), 'OUTSIDE_MUST_SURVIVE')
    assert.equal(await readFile(join(root, 'held', 'value'), 'utf8'), 'INSIDE')
  } finally {
    provider?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a replacement parent directory cannot redirect a missing-target create', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-open-create-race-'))
  let provider
  try {
    const parent = join(root, 'parent')
    const replacement = join(root, 'replacement')
    nodeFs.mkdirSync(parent)
    nodeFs.mkdirSync(replacement)
    provider = new NodeFilesystemProviderV1([{ rootId: 'workspace', hostPath: root }])
    const call = context('parent/new-file')
    const plan = provider.preflight(call, authority)
    plan.requests[0].verify()
    nodeFs.renameSync(parent, join(root, 'held'))
    nodeFs.renameSync(replacement, parent)
    assert.throws(() => plan.execute(call, [authority]), { code: 'resource.stale' })
    assert.equal(nodeFs.existsSync(join(parent, 'new-file')), false)
    assert.equal(nodeFs.existsSync(join(root, 'held', 'new-file')), false)
  } finally {
    provider?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a concurrent leaf appearance fails stale admission without truncating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-open-create-appearance-'))
  let provider
  try {
    provider = new NodeFilesystemProviderV1([{ rootId: 'workspace', hostPath: root }])
    const call = context('new-file')
    const plan = provider.preflight(call, authority)
    plan.requests[0].verify()
    await writeFile(join(root, 'new-file'), 'CONCURRENT_MUST_SURVIVE')
    assert.throws(() => plan.execute(call, [authority]), { code: 'resource.stale' })
    assert.equal(await readFile(join(root, 'new-file'), 'utf8'), 'CONCURRENT_MUST_SURVIVE')
  } finally {
    provider?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('an admitted within-root alias opens its resolved path through the pinned root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-open-within-root-'))
  let provider
  try {
    nodeFs.mkdirSync(join(root, 'real'))
    await writeFile(join(root, 'real', 'value'), 'RESOLVED')
    nodeFs.symlinkSync(join(root, 'real'), join(root, 'alias'))
    provider = new NodeFilesystemProviderV1([{ rootId: 'workspace', hostPath: root }])
    const call = context('alias/value')
    const within = {
      ...authority,
      bindings: [{
        ...authority.bindings[0],
        constraints: {
          ...authority.bindings[0].constraints,
          roots: [{ ...authority.bindings[0].constraints.roots[0], symlinks: 'withinRoot' }]
        }
      }]
    }
    const plan = provider.preflight(call, within)
    plan.requests[0].verify()
    const terminal = plan.execute({ ...call, authorityBindings: within.bindings }, [within])
    assert.equal(await readFile(join(root, 'real', 'value'), 'utf8'), '')
    terminal.resources[0].close()
  } finally {
    provider?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a FIFO replacement cannot block the Node Provider open path', () => {
  const resourcesUrl = new URL('../src/capability-fs-resources.mjs', import.meta.url).href
  const pathsUrl = new URL('../src/capability-fs-paths.mjs', import.meta.url).href
  const script = `
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    const { NodeFilesystemResourcesV1 } = await import(${JSON.stringify(resourcesUrl)});
    const { NodeFilesystemPathsV1, nodeFilesystemIdentityV1 } = await import(${JSON.stringify(pathsUrl)});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holo-open-fifo-race-'));
    const paths = new NodeFilesystemPathsV1([{ rootId: 'workspace', hostPath: root }]);
    try {
      const target = path.join(root, 'target');
      fs.writeFileSync(target, 'ORIGINAL');
      const evidence = {
        kind: 'filesystemTarget', rootId: 'workspace', targetType: 'file',
        targetIdentityDigest: nodeFilesystemIdentityV1(fs.statSync(target, { bigint: true }))
      };
      fs.unlinkSync(target);
      execFileSync('/usr/bin/mkfifo', [target]);
      const flag = {
        kind: 'portable-open-v1', access: 'write', create: true,
        exclusive: false, truncate: true, append: false
      };
      const context = {
        arguments: { flag }, authorityBindings: [{ constraints: { limits: { maxOpenHandles: 8 } } }],
        member: 'open', module: 'node:fs/promises', operation: 'filesystem.file.open',
        runtime: { generation: 1 }, source: { kind: 'linuxProcess' }
      };
      try {
        new NodeFilesystemResourcesV1().open(
          context, { complete: value => value },
          { rootId: 'workspace', pathSegments: ['target'], semanticResourceDigest: 'test' }, evidence,
          flags => paths.openPinned(
            { rootId: 'workspace', pathSegments: ['target'], semanticResourceDigest: 'test' },
            evidence, flags
          )
        );
        process.exitCode = 2;
      } catch { /* A FIFO is never admitted as a regular file. */ }
    } finally {
      paths.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 3000
  })
  assert.equal(result.error, undefined, result.stderr)
  assert.equal(result.status, 0, result.stderr)
})
