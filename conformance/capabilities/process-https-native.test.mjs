import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { it } from 'node:test'

// The Native driver supplies local endpoints and a public CA file through FUSE.
// TLS negotiation and certificate checks execute in Linux curl, inside real holo.
export const registerNativeProcessHttpsTests = fixture => {
  const curl = (url, extra = []) =>
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
          '*',
          '--cacert',
          '/workspace/ca.pem',
          ...extra,
          url
        ],
        { encoding: 'utf8' },
        (error, stdout, stderr) => resolve({ error, stdout, stderr })
      )
    )
  const url = (port, path) => `https://${fixture.address}:${port}${path}`

  it('uses a read-only FUSE CA to verify a local HTTPS server from Linux', async () => {
    assert.equal(process.versions.node, undefined)
    const result = await curl(url(fixture.httpsPort, '/ok'))
    assert.equal(result.error, null)
    assert.equal(result.stdout, 'HTTPS_OK')
    assert.equal(result.stderr, '')
  })

  it('rejects a server signed by a CA other than the supplied CA', async () => {
    const result = await curl(url(fixture.httpsPort, '/wrong-ca'), [
      '--cacert',
      '/workspace/wrong-ca.pem'
    ])
    assert.equal(result.error?.code, 60)
    assert.equal(result.stdout, '')
  })

  it('rejects a trusted certificate for the wrong hostname', async () => {
    const name = 'mismatch.invalid'
    const result = await curl(`https://${name}:${fixture.httpsPort}/wrong-host`, [
      '--resolve',
      `${name}:${fixture.httpsPort}:${fixture.address}`
    ])
    assert.equal(result.error?.code, 60)
    assert.equal(result.stdout, '')
  })

  it('cannot connect to an endpoint absent from Host Process Policy', async () => {
    const result = await curl(url(fixture.policyDeniedPort, '/blocked'))
    assert.ok(result.error)
    assert.equal(result.stdout, '')
  })

  it('cannot connect to an allowed endpoint rejected by Host middleware', async () => {
    const result = await curl(url(fixture.middlewareDeniedPort, '/blocked'))
    assert.ok(result.error)
    assert.equal(result.stdout, '')
  })

  it('checks Process authority again when curl follows an HTTPS redirect', async () => {
    const result = await curl(url(fixture.httpsPort, '/redirect'), ['--location'])
    assert.ok(result.error)
    assert.equal(result.stdout, '')
  })
}
