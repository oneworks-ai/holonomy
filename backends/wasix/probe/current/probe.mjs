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
  const result = {
    filesystemOutput: await directory.readTextFile('guest-output.txt'),
    output: { code: output.code, stderr: output.stderr, stdout: output.stdout },
    workloadDurationMs: Math.round(performance.now() - workloadStartedAt)
  }
  process.stdout.write(`HOLO_PROBE_RESULT ${JSON.stringify(result)}\n`)
  directory.free()
  runtime.free()
}

const controller = async () => {
  const run = await runIsolatedProbe(new URL(import.meta.url))
  const regression = run.stderr.includes('Not able to serialize module')
  const passed = run.result?.output.code === 7 &&
    run.result.output.stdout === 'WASIX_STDIN\nHOST_TO_WASIX\n' &&
    run.result.output.stderr === 'WASIX_STDERR\n' &&
    run.result.filesystemOutput === 'GUEST_TO_HOST\n'
  process.stderr.write(
    `WASIX 0.10 exit=${run.exitCode} signal=${run.signal} ` +
      `serializationRegression=${regression} lingered=${run.killedForLingeringRuntime}\n`
  )
  await publishEvidence({
    artifact: {
      artifactKind: 'npm',
      artifactVersion: '0.10.0',
      integritySha256: '4c1c40130a4a52a378edf14d92cd314093a1446e5a95ae384898e0a5082c3c42',
      license: 'MIT',
      sourceRevision: '7e3a7a35f35f6fb15229b06a567ed838a97b7cca'
    },
    backendId: 'experimental.wasix-js-v1',
    host: nodeV8Host(),
    metrics: {
      ...(run.boot == null ? {} : { bootDurationMs: run.boot.bootDurationMs }),
      workloadDurationMs: run.durationMs
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
        passed ? undefined : regression ? 'wasix.module_serialization_regression' : 'wasix.workload_failed'
      ),
      observation(
        'stdio',
        passed ? 'passed' : 'notRun',
        passed ? 'behavioralProbe' : 'upstreamContract',
        passed ? undefined : 'wasix.workload_not_started'
      ),
      observation(
        'exit',
        passed ? 'passed' : 'notRun',
        passed ? 'behavioralProbe' : 'upstreamContract',
        passed ? undefined : 'wasix.workload_not_started'
      ),
      observation(
        'filesystem',
        passed ? 'passed' : 'notRun',
        passed ? 'behavioralProbe' : 'upstreamContract',
        passed ? undefined : 'wasix.current_workload_failed'
      ),
      observation('network', 'unsupported', 'upstreamContract', 'wasix.networking_incomplete'),
      observation('processTree', 'unsupported', 'upstreamContract', 'wasix.termination_api_missing'),
      observation(
        'runtime',
        passed ? run.killedForLingeringRuntime ? 'failed' : 'passed' : 'unsupported',
        passed ? 'behavioralProbe' : 'upstreamContract',
        passed
          ? run.killedForLingeringRuntime ? 'wasix.runtime_cleanup_leaked' : undefined
          : 'wasix.shared_environment_missing'
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
