import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { nodeV8Host, observation, publishEvidence } from '../../probe-evidence.mjs'

const artifact = {
  artifactKind: 'npm',
  artifactVersion: '0.2.15',
  integritySha256: '3508c0536189af7f7e6c6fc37447efff83fe20ab6f453f3a2231e1a4b597f70c',
  license: 'Apache-2.0',
  sourceRevision: '36843a854ef7609a77d160bce1fd6bce2bb7ebd2'
}

const main = async () => {
  const { AgentOs, createHostDirBackend } = await import('@rivet-dev/agentos-core')
  const hostDirectory = await mkdtemp(path.join(os.tmpdir(), 'holonomy-agentos-probe-'))
  await chmod(hostDirectory, 0o777)
  await writeFile(path.join(hostDirectory, 'input.txt'), 'HOST_TO_AGENTOS\n')
  const server = createServer((_request, response) => response.end('AGENTOS_NETWORK_OK'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  let sidecar
  let vm
  let bootDurationMs
  let workloadDurationMs
  let networkStatus = 'failed'
  let networkReason = 'agentos.process_network_failed'
  try {
    const bootStartedAt = performance.now()
    sidecar = await AgentOs.createSidecar()
    const user = os.userInfo()
    vm = await AgentOs.create({
      loopbackExemptPorts: [address.port],
      mounts: [{
        path: '/workspace',
        plugin: createHostDirBackend({ hostPath: hostDirectory, readOnly: false }),
        readOnly: false
      }],
      sidecar: { kind: 'explicit', handle: sidecar },
      user: {
        uid: user.uid,
        gid: user.gid,
        euid: user.uid,
        egid: user.gid,
        username: user.username
      }
    })
    bootDurationMs = Math.round(performance.now() - bootStartedAt)

    const workloadStartedAt = performance.now()
    const result = await vm.process.exec(
      "printf 'AGENTOS_STDOUT\\n'; printf 'AGENTOS_STDERR\\n' >&2; " +
        "cat /workspace/input.txt; printf 'AGENTOS_TO_HOST\\n' > /workspace/output.txt; exit 7",
      { output: { capture: 'all' } }
    )
    workloadDurationMs = Math.round(performance.now() - workloadStartedAt)
    assert.equal(result.exitCode, 7)
    assert.match(result.stdout ?? '', /AGENTOS_STDOUT/u)
    assert.match(result.stdout ?? '', /HOST_TO_AGENTOS/u)
    assert.match(result.stderr ?? '', /AGENTOS_STDERR/u)
    assert.equal(await readFile(path.join(hostDirectory, 'output.txt'), 'utf8'), 'AGENTOS_TO_HOST\n')

    await vm.filesystem.writeFile('/tmp/holonomy.txt', 'VM_FILESYSTEM_OK')
    assert.equal(new TextDecoder().decode(await vm.filesystem.readFile('/tmp/holonomy.txt')), 'VM_FILESYSTEM_OK')

    const child = await vm.process.spawn('sleep', ['30'])
    assert.equal((await vm.process.get(child.pid)).state, 'running')
    assert.ok((await vm.process.list()).some(process => process.pid === child.pid))
    assert.ok((await vm.process.tree()).some(process => process.pid === child.pid))
    await vm.process.signal(child.pid, 'SIGTERM')
    assert.equal((await vm.process.wait(child.pid)).outcome, 'signalled')

    const network = await vm.process.execFile('curl', [
      '--fail',
      '--max-time',
      '2',
      `http://127.0.0.1:${address.port}/`
    ], { output: { capture: 'all' } })
    if (network.outcome === 'succeeded' && network.stdout === 'AGENTOS_NETWORK_OK') {
      networkStatus = 'passed'
      networkReason = undefined
    } else if (network.error?.message?.includes('command not found')) {
      networkReason = 'agentos.curl_not_packaged'
    }

    process.stderr.write(
      `agentOS exit=${result.exitCode} stdout=${JSON.stringify(result.stdout)} ` +
        `stderr=${JSON.stringify(result.stderr)} network=${networkStatus}\n`
    )
  } finally {
    await vm?.dispose()
    await sidecar?.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(hostDirectory, { recursive: true, force: true })
  }

  await publishEvidence({
    artifact,
    backendId: 'experimental.agentos-v1',
    host: nodeV8Host(),
    metrics: { bootDurationMs, workloadDurationMs },
    observations: [
      observation('installation', 'passed', 'behavioralProbe'),
      observation('boot', 'passed', 'behavioralProbe'),
      observation('workload', 'passed', 'behavioralProbe'),
      observation('stdio', 'passed', 'behavioralProbe'),
      observation('exit', 'passed', 'behavioralProbe'),
      observation('filesystem', 'passed', 'behavioralProbe'),
      observation('network', networkStatus, 'behavioralProbe', networkReason),
      observation('processTree', 'passed', 'behavioralProbe'),
      observation('runtime', 'passed', 'behavioralProbe'),
      observation('snapshots', 'unsupported', 'upstreamContract', 'agentos.snapshot_api_missing'),
      observation('androidPackaging', 'unsupported', 'upstreamContract', 'agentos.android_artifact_missing')
    ],
    schemaVersion: 1
  })
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
