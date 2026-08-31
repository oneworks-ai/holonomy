import assert from 'node:assert/strict'

export const processControlRuntimeSource = `
      stage('process-control')
      const processTimeout = await new Promise(resolve => {
        const child = spawn('shell', ['-c', 'while :; do :; done'], { timeout: 50 })
        let errorCode
        child.on('error', error => { errorCode = error.code })
        child.on('close', (code, signal) => resolve({ code, errorCode, signal }))
      })
      const controller = new AbortController()
      const processAbort = await new Promise(resolve => {
        const child = execFile(
          'shell', ['-c', 'while :; do :; done'], { encoding: 'utf8', signal: controller.signal },
          function(error, stdout, stderr) {
            resolve({ arity: arguments.length, errorCode: error?.code, stderr, stdout })
          },
        )
        child.on('spawn', () => controller.abort())
      })
      const processFlow = await new Promise((resolve, reject) => {
        const child = spawn('shell', ['-c', 'sleep 0.15; printf FIRST; sleep 0.15; printf SECOND'])
        let output = ''
        let outputWhilePaused
        child.stdout.on('data', chunk => { output += new TextDecoder().decode(chunk) })
        child.on('error', reject)
        child.stdout.pause()
        setTimeout(() => {
          outputWhilePaused = output
          child.stdout.resume()
        }, 225)
        child.on('close', (code, signal) => resolve({ code, output, outputWhilePaused, signal }))
      })
      const processControl = { abort: processAbort, flow: processFlow, timeout: processTimeout }
`

export const assertProcessControlResult = result => {
  assert.deepEqual(result.timeout, { code: null, errorCode: 'ETIMEDOUT', signal: 'SIGKILL' })
  assert.deepEqual(result.abort, { arity: 3, errorCode: 'ABORT_ERR', stderr: '', stdout: '' })
  assert.deepEqual(result.flow, {
    code: 0,
    output: 'FIRSTSECOND',
    outputWhilePaused: '',
    signal: null
  })
}
