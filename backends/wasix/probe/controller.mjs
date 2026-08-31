import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const marker = (output, prefix) => {
  const line = output.split('\n').find(item => item.startsWith(prefix))
  return line == null ? undefined : JSON.parse(line.slice(prefix.length))
}

export const runIsolatedProbe = moduleUrl =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn(process.execPath, [fileURLToPath(moduleUrl), '--workload-child'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let resultSeenAt
    let killedForLingeringRuntime = false
    const hardTimeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    const lingerCheck = setInterval(() => {
      if (resultSeenAt != null && performance.now() - resultSeenAt >= 300) {
        killedForLingeringRuntime = true
        child.kill('SIGKILL')
      }
    }, 25)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.includes('HOLO_PROBE_RESULT ')) resultSeenAt ??= performance.now()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => {
      clearTimeout(hardTimeout)
      clearInterval(lingerCheck)
      resolve({
        boot: marker(stdout, 'HOLO_PROBE_BOOT '),
        durationMs: Math.round(performance.now() - startedAt),
        exitCode,
        killedForLingeringRuntime,
        result: marker(stdout, 'HOLO_PROBE_RESULT '),
        signal,
        stderr
      })
    })
  })
