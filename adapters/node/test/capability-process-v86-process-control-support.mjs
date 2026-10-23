import assert from 'node:assert/strict'

export const processControlRuntimeSource = `
      stage('process-control')
      const processTimeout = await new Promise(resolve => {
        const child = spawn('shell', ['-c', 'printf READY; IFS= read -r line'], { timeout: 45_000 })
        let errorCode
        let readyOutput = ''
        child.stdout.on('data', chunk => { readyOutput += new TextDecoder().decode(chunk) })
        child.on('error', error => { errorCode = error.code })
        child.on('close', (code, signal) => resolve({ code, errorCode, ready: readyOutput === 'READY', signal }))
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
        const child = spawn('shell', ['-c', 'printf FIRST; IFS= read -r line; printf SECOND; IFS= read -r line'])
        let output = ''
        let outputWhilePaused
        let paused = false
        let released = false
        let pauseTimer
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error('Timed out waiting for controlled v86 readable flow'))
        }, 120_000)
        child.stdout.on('data', chunk => {
          output += new TextDecoder().decode(chunk)
          if (!paused && output === 'FIRST') {
            paused = true
            child.stdout.pause()
            child.stdin.write('continue\\n')
            pauseTimer = setTimeout(() => {
              outputWhilePaused = output
              child.stdout.resume()
            }, 225)
          } else if (!released && output === 'FIRSTSECOND') {
            released = true
            child.stdin.write('finish\\n')
            child.stdin.end()
          }
        })
        child.on('error', error => {
          clearTimeout(timeout)
          clearTimeout(pauseTimer)
          reject(error)
        })
        child.on('close', (code, signal) => {
          clearTimeout(timeout)
          clearTimeout(pauseTimer)
          resolve({ code, output, outputWhilePaused, signal })
        })
      })
      const processControl = { abort: processAbort, flow: processFlow, timeout: processTimeout }
`

export const assertProcessControlResult = result => {
  assert.deepEqual(result.timeout, { code: null, errorCode: 'ETIMEDOUT', ready: true, signal: 'SIGKILL' })
  assert.deepEqual(result.abort, { arity: 3, errorCode: 'ABORT_ERR', stderr: '', stdout: '' })
  assert.deepEqual(result.flow, {
    code: 0,
    output: 'FIRSTSECOND',
    outputWhilePaused: 'FIRST',
    signal: null
  })
}
