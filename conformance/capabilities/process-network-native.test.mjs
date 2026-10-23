import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { it } from 'node:test'

// The profile-bound Host driver supplies only its public fixture endpoints.
// All child_process API/result assertions execute here in real Holonomy JS.
export const registerNativeProcessNetworkTests = fixture => {
  const netcat = async (args, input) => {
    const child = spawn('nc', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', bytes => stdout += new TextDecoder().decode(bytes))
    child.stderr.on('data', bytes => stderr += new TextDecoder().decode(bytes))
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
    child.stdin.write(input)
    child.stdin.end()
    return await done
  }
  const curl = url =>
    new Promise(resolve =>
      execFile(
        'curl',
        [
          '--silent',
          '--show-error',
          '--fail',
          '--max-time',
          '8',
          '--noproxy',
          '',
          '--proxy',
          'http://192.168.86.1:80',
          url
        ],
        { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })
      )
    )

  it('exchanges TCP bytes from a real Linux process without Node', async () => {
    assert.equal(process.versions.node, undefined)
    const result = await netcat(['-w', '5', fixture.address, String(fixture.tcpPort)], 'TCP_REQUEST')
    assert.deepEqual(result, { code: 0, signal: null, stdout: 'TCP_RESPONSE', stderr: '' })
  })

  it('exchanges UDP bytes through the same Process authority', async () => {
    const result = await netcat(['-u', '-w', '2', fixture.address, String(fixture.udpPort)], 'UDP_REQUEST')
    assert.deepEqual(result, { code: 0, signal: null, stdout: 'UDP_RESPONSE', stderr: '' })
  })

  it('runs curl through the pinned VM HTTP proxy and Host address pin', async () => {
    const result = await curl(`http://${fixture.address}:${fixture.httpPort}/case`)
    assert.equal(result.error, null)
    assert.equal(result.stdout, 'HTTP_RESPONSE')
    assert.equal(result.stderr, '')
  })

  it('resolves the vendor localhost proxy endpoint using real Host DNS evidence', async () => {
    // The pinned proxy rewrites PORT.external to localhost:PORT. This tests
    // Host resolution, not a claim of Guest AF_INET6 or arbitrary DNS support.
    const result = await curl(`http://${fixture.httpPort}.external/case`)
    assert.equal(result.error, null)
    assert.equal(result.stdout, 'HTTP_RESPONSE')
    assert.equal(result.stderr, '')
  })

  it('does not reach a Host endpoint denied by process-aware middleware', async () => {
    const result = await curl(`http://${fixture.address}:${fixture.deniedPort}/case`)
    assert.ok(result.error)
    assert.equal(result.stdout, '')
  })

  it('reauthorizes an HTTP redirect and refuses the denied next endpoint', async () => {
    const result = await curl(`http://${fixture.address}:${fixture.httpPort}/redirect/${fixture.deniedPort}`)
    assert.ok(result.error)
    assert.equal(result.stdout, '')
  })
}
