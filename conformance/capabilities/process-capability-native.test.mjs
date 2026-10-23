import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { it } from 'node:test'

// This file runs inside the actual Native Runtime. The Host driver selects only
// profile domains and private Device/System authority, not test results.
export const registerNativeProcessCapabilityTests = ({ enabled }) => {
  const command = args =>
    new Promise(resolve =>
      execFile('hoholo', args, { encoding: 'utf8' }, function(error, stdout, stderr) {
        resolve({ code: error?.code ?? 0, stdout, stderr, callbackArity: arguments.length })
      })
    )
  const success = result => {
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.callbackArity, 3)
    return JSON.parse(result.stdout)
  }
  const refused = (result, code) => {
    assert.equal(result.code, 1)
    assert.equal(result.callbackArity, 3)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `${code}\n`)
    assert.equal(result.stderr.includes('HOST_ALLOWED_BUT_MIDDLEWARE_DENIED'), false)
  }
  if (!enabled) {
    it('keeps Device and System bridges closed despite separately granted Host authority', async () => {
      refused(await command(['system', 'read', 'os.arch']), 'bridge.unavailable')
      refused(await command(['device', 'summary']), 'bridge.unavailable')
    })
    return
  }
  it('reads the selected Host System projection through checked distinct Linux process sources', async () => {
    assert.equal(process.versions.node, undefined)
    assert.equal(success(await command(['system', 'read', 'os.arch'])), 'x64')
  })
  it('uses the installed Native Device Provider with a coarse precision ceiling', async () => {
    const reading = success(await command(['device', 'read', 'device.form-factor.read']))
    assert.equal(reading.status, 'available')
    assert.equal(reading.precision, 'coarse')
    assert.ok(['desktop', 'unknown'].includes(reading.value))
    assert.ok(Number.isSafeInteger(reading.revision) && reading.revision >= 1)
  })
  it('does not expand Summary children beyond independently granted Device fields', async () => {
    const summary = success(await command(['device', 'summary']))
    assert.deepEqual(Object.keys(summary).sort(), [
      'display',
      'formFactor',
      'input',
      'lifecycle',
      'power',
      'schemaVersion'
    ])
    assert.equal(summary.schemaVersion, 1)
    assert.equal(summary.formFactor.status, 'available')
    assert.equal(summary.formFactor.precision, 'coarse')
    for (const field of ['display', 'input', 'lifecycle', 'power']) {
      assert.equal(summary[field].status, 'permissionDenied', field)
      assert.equal(summary[field].precision, 'none', field)
      assert.equal(summary[field].revision, 0, field)
      assert.equal(Object.hasOwn(summary[field], 'value'), false, field)
    }
  })
  it('lets Host middleware refuse a selected System value before returning it to Linux', async () => {
    refused(await command(['system', 'read', 'os.hostname']), 'middleware.permission_denied')
  })
  it('does not let an enabled Device bridge bypass Policy for Tier 2 state', async () => {
    refused(await command(['device', 'read', 'device.connectivity.read']), 'policy.denied')
  })
  it('refuses unknown Device commands without falling back to native OS access', async () => {
    refused(await command(['device', 'read', 'device.not-real.read']), 'bridge.unsupported')
  })
  it('does not turn the one-shot capability protocol into an event subscription', async () => {
    refused(await command(['device', 'read', 'device.events.subscribe']), 'bridge.unsupported')
  })
}
