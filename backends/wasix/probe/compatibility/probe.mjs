import assert from 'node:assert/strict'
import process from 'node:process'
import { nodeV8Host, observation, publishEvidence } from '../../../probe-evidence.mjs'
import { runIsolatedProbe } from '../controller.mjs'
import { WASIX_PROBE_WAT } from '../workload.mjs'

const workloadChild = async () => {
  const { Directory, Runtime, init, runWasix, wat2wasm } = await import('@wasmer/sdk/node')
  const bootStartedAt = performance.now()
  await init()
  process.stdout.write(`HOLO_PROBE_BOOT ${
    JSON.stringify({
      bootDurationMs: Math.round(performance.now() - bootStartedAt)
    })
  }\n`)
  const runtime = new Runtime({ registry: null })
  const directory = new Directory({ 'input.txt': 'HOST_TO_WASIX\n' })
  const workloadStartedAt = performance.now()
  const instance = await runWasix(wat2wasm(WASIX_PROBE_WAT), {
    stdin: 'WASIX_STDIN\n',
    mount: { '/workspace': directory },
    runtime
  })
  const output = await instance.wait()
  const filesystemOutput = await directory.readTextFile('guest-output.txt')
  assert.equal(output.code, 7)
  assert.equal(output.stdout, 'WASIX_STDIN\nHOST_TO_WASIX\n')
  assert.equal(output.stderr, 'WASIX_STDERR\n')
  assert.equal(filesystemOutput, 'GUEST_TO_HOST\n')
  process.stdout.write(`HOLO_PROBE_RESULT ${
    JSON.stringify({
      filesystemOutput,
      output: { code: output.code, stderr: output.stderr, stdout: output.stdout },
      workloadDurationMs: Math.round(performance.now() - workloadStartedAt)
    })
  }\n`)
  directory.free()
  runtime.free()
}

const controller = async () => {
  const run = await runIsolatedProbe(new URL(import.meta.url))
  const passed = run.result?.output.code === 7 &&
    run.result.output.stdout === 'WASIX_STDIN\nHOST_TO_WASIX\n' &&
    run.result.output.stderr === 'WASIX_STDERR\n' &&
    run.result.filesystemOutput === 'GUEST_TO_HOST\n'
  process.stderr.write(
    `WASIX 0.9 workload=${passed ? 'passed' : 'failed'} ` +
      `lingerAfterRuntimeFree=${run.killedForLingeringRuntime}\n`
  )
  await publishEvidence({
    artifact: {
      artifactKind: 'npm',
      artifactVersion: '0.9.0',
      integritySha256: '9cd2b0d1b4b3b2dd2c0a8743a9f9904dd6e5022db4c373b4a05d91d3ad3343e4',
      license: 'MIT'
    },
    backendId: 'experimental.wasix-js-v1',
    host: nodeV8Host(),
    metrics: {
      ...(run.boot == null ? {} : { bootDurationMs: run.boot.bootDurationMs }),
      ...(run.result == null ? {} : { workloadDurationMs: run.result.workloadDurationMs })
    },
    observations: [
      observation('installation', 'passed', 'behavioralProbe'),
      observation(
        'boot',
        run.boot == null ? 'failed' : 'passed',
        'behavioralProbe',
        run.boot == null ? 'wasix.initialization_failed' : undefined
      ),
      observation(
        'workload',
        passed ? 'passed' : 'failed',
        'behavioralProbe',
        passed ? undefined : 'wasix.workload_failed'
      ),
      observation('stdio', passed ? 'passed' : 'failed', 'behavioralProbe', passed ? undefined : 'wasix.stdio_failed'),
      observation('exit', passed ? 'passed' : 'failed', 'behavioralProbe', passed ? undefined : 'wasix.exit_failed'),
      observation(
        'filesystem',
        passed ? 'passed' : 'failed',
        'behavioralProbe',
        passed ? undefined : 'wasix.filesystem_failed'
      ),
      observation('network', 'unsupported', 'upstreamContract', 'wasix.networking_incomplete'),
      observation('processTree', 'notRun', 'upstreamContract', 'wasix.subprocess_probe_not_reconstructed'),
      observation(
        'runtime',
        run.killedForLingeringRuntime ? 'failed' : 'passed',
        'behavioralProbe',
        run.killedForLingeringRuntime ? 'wasix.runtime_cleanup_leaked' : undefined
      ),
      observation('snapshots', 'unsupported', 'upstreamContract', 'wasix.snapshot_api_missing'),
      observation('androidPackaging', 'unsupported', 'profileStaticUnsupported', 'android.worker_host_missing')
    ],
    schemaVersion: 1
  })
}

const main = async () => process.argv.includes('--workload-child') ? workloadChild() : controller()

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
