/* eslint-disable test/no-import-node-test -- Native CLI driver; public assertions execute in Guest JS. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { createNativeV86PublicFixture } from './v86_public_fixture.mjs'

const workload = new URL('../../../conformance/capabilities/process-capability-native.test.mjs', import.meta.url)
const executables = [{ executableId: 'hoholo', path: '/usr/bin/hoholo' }]
const processPolicy = {
  access: 'sandboxed',
  environment: { allowedNames: [], maxValueBytes: 1024 },
  executables: [{ executableId: 'hoholo', argumentBytes: 4096 }],
  shell: { access: 'none' },
  mounts: [],
  network: { access: 'none' },
  limits: {
    maxConcurrentProcesses: 1,
    maxTotalProcesses: 8,
    maxProcessTreeDepth: 1,
    maxExecutionTimeMs: 30_000,
    maxStdinBytes: 1024,
    maxStdoutBytes: 8192,
    maxStderrBytes: 4096,
    maxOpenPipes: 3,
    maxWritableRootfsBytes: 0
  }
}
const hostConfig = {
  deviceProvider: { implementation: 'builtin.darwin-device-v1' },
  plugins: [{ id: 'linux-source-check', use: './plugin.mjs' }],
  systemProjection: {
    schemaVersion: 1,
    fields: {
      'os.arch': { mode: 'synthetic', precision: 'exact', value: 'x64' },
      'os.hostname': { mode: 'synthetic', precision: 'exact', value: 'HOST_ALLOWED_BUT_MIDDLEWARE_DENIED' }
    }
  },
  sandboxPolicy: {
    schemaVersion: 2,
    process: processPolicy,
    systemInformation: {
      defaultMode: 'unavailable',
      fields: {
        'os.arch': { allowedModes: ['synthetic'], maxPrecision: 'exact' },
        'os.hostname': { allowedModes: ['synthetic'], maxPrecision: 'exact' }
      }
    },
    device: {
      defaultAccess: 'deny',
      maxEventsPerSecond: 1,
      maxQueuedEvents: 0,
      maxSubscriptions: 0,
      operations: {
        'device.summary.read': { access: 'allow', maxPrecision: 'standard', maxPrivacyTier: 1 },
        'device.form-factor.read': { access: 'allow', maxPrecision: 'coarse', maxPrivacyTier: 0 }
      }
    }
  }
}
const plugin = `export default ctx => {
  const seen = new Set();
  const intercept = operation => ctx.holo.intercept({operation}, (request,next) => {
    const s=request.source;
    if(!s||s.kind!=='linuxProcess'||s.executableId!=='hoholo'||s.environmentScope!=='processTree'||
       ![s.linuxPid,s.parentLinuxPid,s.rootLinuxPid,s.syntheticProcessId]
         .every(value=>Number.isSafeInteger(value)&&value>=1)||
       s.processStartTimeTicks!==undefined&&
         (!Number.isSafeInteger(s.processStartTimeTicks)||s.processStartTimeTicks<1)||
       s.rootLinuxPid!==s.linuxPid||s.parentLinuxPid===s.linuxPid||
       typeof s.environmentId!=='string'||s.environmentId.length===0||
       typeof s.processResourceId!=='string'||s.processResourceId.length===0)return ctx.holo.deny(request);
    const identity=JSON.stringify([s.environmentId,s.processResourceId]);
    if(seen.has(identity))return ctx.holo.deny(request);
    seen.add(identity);
    if(operation==='system.os.hostname.read')return ctx.holo.deny(request);
    return next();
  }, {execution:'sync'});
  for(const operation of ['system.os.arch.read','system.os.hostname.read',
    'device.summary.read','device.form-factor.read'])intercept(operation);
};`

test('Native hoholo uses the same selected Device/System authority and preserves default-closed domains', {
  timeout: 130_000
}, async t => {
  for (const enabled of [true, false]) {
    const fixture = await createNativeV86PublicFixture({
      testContext: t,
      prefix: 'holo-v86-capability-public-',
      executables,
      domains: enabled ? ['device', 'system'] : [],
      hostConfig
    })
    try {
      await fixture.write('plugin.mjs', plugin)
      await fixture.write('workload.mjs', await readFile(workload))
      await fixture.write(
        'capability.test.mjs',
        `import {registerNativeProcessCapabilityTests} from './workload.mjs';
         registerNativeProcessCapabilityTests({enabled:${enabled}});`
      )
      const result = await fixture.run('capability.test.mjs', { timeoutMs: 60_000 })
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.equal(result.signal, null)
      const report = result.stdout.split('\n').map(line => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).find(value => Array.isArray(value?.results))
      assert(report, result.stdout + result.stderr)
      assert.equal(report.total, enabled ? 7 : 1)
      assert.equal(report.passed, report.total, result.stdout + result.stderr)
      assert.equal(report.failed, 0)
      assert.equal(report.skipped, 0)
      t.diagnostic(JSON.stringify({ runtime: 'holo', domainsEnabled: enabled, guestReport: report }))
    } finally {
      await fixture.dispose()
    }
  }
})
