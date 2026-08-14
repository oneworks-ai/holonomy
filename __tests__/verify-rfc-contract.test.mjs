import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, test } from 'vitest'
import { verifyRfcContract } from './verify-rfc-contract-support.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = join(repositoryRoot, '.oo/rules/rfcs')
const temporaryRoots = []
afterAll(async () => Promise.all(temporaryRoots.map(path => rm(path, { force: true, recursive: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holonomy-rfc-contract-'))
  temporaryRoots.push(root)
  await cp(sourceRoot, root, { recursive: true })
  return root
}

async function expectFailure(mutate, pattern) {
  const root = await fixture()
  await mutate(root)
  await expect(verifyRfcContract(root)).rejects.toThrow(pattern)
}

test('rejects TypeScript syntax errors', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/core-contract-types.md')
    await writeFile(path, `${await readFile(path, 'utf8')}\n\`\`\`ts\ninterface BrokenV1 {\n\`\`\`\n`)
  }, /TypeScript/)
})

test('rejects duplicate normative type owners', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/milestones.md')
    await writeFile(path, `${await readFile(path, 'utf8')}\n\`\`\`ts\ninterface DisposableV1 {}\n\`\`\`\n`)
  }, /duplicate type owner/)
})

test('rejects missing required fragments', async () => {
  await expectFailure(
    root => unlink(join(root, '0001-holo-capability-runtime/observer-contract-v1.md')),
    /manifest|required RFC file/
  )
})

test('rejects fragments no longer reachable from overview', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime.md')
    const source = await readFile(path, 'utf8')
    await writeFile(path, source.replace(/^.*observer-contract-v1\.md.*\n/m, ''))
  }, /missing direct RFC overview link/)
})

test('rejects operations outside closed registries', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/network-operation-registry.md')
    await writeFile(path, `${await readFile(path, 'utf8')}\nUnknown: \`network.unknown.connect\`.\n`)
  }, /operation outside closed union/)
})

test('rejects closed operations missing their Registry row', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/network-operation-registry.md')
    const source = await readFile(path, 'utf8')
    await writeFile(path, source.replace(/^\| global\/WebSocket .*\n/m, ''))
  }, /missing Registry row for network\.websocket\.connect/)
})

test.each([
  ['Node', 'ERR_HOLO_NOT_REAL', /Node error outside closed union/],
  ['internal', 'provider.not_real', /internal error outside closed union/],
  ['admission', 'runtime.binding_not_real', /admission error outside closed union/]
])('rejects unknown %s error literals', async (_family, literal, pattern) => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/error-contract-v1.md')
    await writeFile(path, `${await readFile(path, 'utf8')}\nUnknown: ${literal}.\n`)
  }, pattern)
})

test.each([
  ['capability', 'allOf(host.process.execute)', 'allOf(host.fs)'],
  ['delivery', 'ProcessSyncDeliveryV1', 'ProcessExecDeliveryV1'],
  ['interception', 'open/host', 'open/systemOnly'],
  [
    'callback tuple',
    'ChildProcessFacadeV1 / ProcessExecCallbackDeliveryV1',
    'ChildProcessFacadeV1 / ProcessStdinCallbackDeliveryV1'
  ],
  ['resource', 'ProcessExecutableResourceV1→ProcessInstanceResourceV1', 'ProcessInstanceResourceV1']
])('rejects Process Registry drift in %s', async (_field, before, after) => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/process-operation-registry.md')
    const source = await readFile(path, 'utf8')
    const lines = source.split('\n')
    const index = lines.findIndex(line => line.startsWith('| spawn shell=false'))
    if (_field === 'delivery' && index >= 0) lines[index] = lines[index].replace(before, after)
    else await writeFile(path, source.replace(before, after))
    if (_field === 'delivery') await writeFile(path, lines.join('\n'))
  }, /Registry semantic signature differs/)
})

test('rejects stdin end releasing its resource before the native terminal', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/process-operation-registry.md')
    const source = await readFile(path, 'utf8')
    await writeFile(
      path,
      source.replace('write/systemOnly  | process.stdin.end', 'close/systemOnly  | process.stdin.end')
    )
  }, /Registry semantic signature differs/)
})

test('rejects child_process error mapping drift', async () => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/error-contract-v1.md')
    const source = await readFile(path, 'utf8')
    await writeFile(path, source.replace('ERR_CHILD_PROCESS_STDIO_MAXBUFFER/Error', 'EFBIG/Error'))
  }, /error mapping semantic signature differs/)
})

test.each([
  [
    'schema owner',
    'process-operation-registry.md',
    'interface ProcessExecArgsV1',
    'interface RemovedProcessExecArgsV1',
    /Registry schema has no normative owner/
  ],
  [
    'immediate result',
    'process-operation-registry.md',
    "immediateResultSchemaId: 'ChildProcessFacadeV1'",
    "immediateResultSchemaId: 'boolean'",
    /missing required normative Process contract/
  ],
  [
    'resource events',
    'process-operation-registry.md',
    "eventSchemaId: 'ChildProcessEventV1'",
    "eventSchemaId: 'ProcessExecSuccessTupleV1'",
    /missing required normative Process contract/
  ],
  [
    'readable resource events',
    'process-operation-registry.md',
    "type ProcessReadableEventDeliveryV1 = Readonly<{\n  kind: 'resourceEvents'\n  eventSchemaId: 'ChildProcessReadableEventV1'\n  terminalEvent: 'close'\n}>",
    "type ProcessReadableEventDeliveryV1 = Readonly<{\n  kind: 'resourceEvents'\n  eventSchemaId: 'ChildProcessReadableEventV1'\n  terminalEvent: 'end'\n}>",
    /missing required normative Process contract/
  ],
  [
    'command digest',
    'process-and-linux-backend.md',
    'readonly commandDigest: string',
    'readonly commandLabel: string',
    /missing required normative Process contract/
  ],
  [
    'program argv digest field',
    'process-and-linux-backend.md',
    'readonly argvDigest: string',
    'readonly argvLabel: string',
    /missing required normative Process contract/
  ],
  [
    'program argv digest formula',
    'resources-and-snapshots.md',
    "['processExecutable','program',executableId,argvDigest",
    "['processExecutable','program',executableId,commandDigest",
    /missing required normative Process contract/
  ],
  [
    'stdout facade',
    'process-resource-protocol.md',
    'readonly stdout: ChildProcessReadableFacadeV1 | null',
    'readonly output: ChildProcessReadableFacadeV1 | null',
    /missing required normative Process contract/
  ],
  [
    'stdin null callback',
    'process-resource-protocol.md',
    'callback?: (error: NodeErrorSnapshotV1 | null) => void\n  ): boolean',
    'callback?: (error?: NodeErrorSnapshotV1) => void\n  ): boolean',
    /missing required normative Process contract/
  ],
  [
    'stdin end null callback',
    'process-resource-protocol.md',
    'end(callback?: (error: NodeErrorSnapshotV1 | null) => void): this',
    'end(callback?: (error?: NodeErrorSnapshotV1) => void): this',
    /missing required normative Process contract/
  ],
  [
    'shell args exclusion',
    'process-operation-registry.md',
    "extends Omit<ProcessSpawnOptionsV1, 'executableId' | 'args' | 'shell'>",
    "extends Omit<ProcessSpawnOptionsV1, 'executableId' | 'shell'>",
    /missing required normative Process contract/
  ],
  [
    'stdio tuple',
    'process-operation-registry.md',
    "readonly stdio?: readonly [\n    stdin: 'pipe' | 'ignore',\n    stdout: 'pipe' | 'ignore',\n    stderr: 'pipe' | 'ignore'\n  ]",
    "readonly stdio?: readonly ('pipe' | 'ignore')[]",
    /missing required normative Process contract/
  ]
])('rejects Process normative %s drift', async (_field, file, before, after, pattern) => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime', file)
    await writeFile(path, (await readFile(path, 'utf8')).replace(before, after))
  }, pattern)
})

test.each([
  [
    'resource scheme',
    'readonly rootUrl: `holo-plugins:///' + '$' + '{string}/`',
    'readonly rootUrl: `holo:///plugins/' + '$' + '{string}/`'
  ],
  [
    'last-known-good update',
    'last-known-good plugin graph 完全不变',
    'active plugin graph may be cleared'
  ],
  [
    'graph revision fencing',
    '原子发布递增的 `pluginGraphRevision`',
    '直接修改当前 plugin graph'
  ]
])('rejects Runtime Plugin %s drift', async (_field, before, after) => {
  await expectFailure(async root => {
    const path = join(root, '0001-holo-capability-runtime/runtime-plugins-and-watch.md')
    await writeFile(path, (await readFile(path, 'utf8')).replace(before, after))
  }, /missing required Runtime Plugin contract/)
})
