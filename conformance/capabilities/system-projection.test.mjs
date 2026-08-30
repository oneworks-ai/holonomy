import assert from 'node:assert/strict'
import {
  arch,
  availableParallelism,
  cpus,
  freemem,
  homedir,
  hostname,
  loadavg,
  machine,
  networkInterfaces,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
  version
} from 'node:os'
import process from 'node:process'
import { describe, it } from 'node:test'

describe('Host System projection', () => {
  it('uses all declared projection modes without leaking Host-only values', () => {
    let releaseError
    try {
      release()
    } catch (error) {
      releaseError = { code: error.code }
    }
    const result = {
      os: {
        arch: arch(),
        availableParallelism: availableParallelism(),
        cpus: cpus(),
        freemem: freemem(),
        homedir: homedir(),
        hostname: hostname(),
        loadavg: loadavg(),
        machine: machine(),
        networkInterfaces: networkInterfaces(),
        platform: platform(),
        releaseError,
        tmpdir: tmpdir(),
        totalmem: totalmem(),
        type: type(),
        uptime: uptime(),
        userInfo: userInfo(),
        version: version()
      },
      process: {
        cwd: process.cwd(),
        env: process.env,
        execPath: process.execPath,
        pid: process.pid
      }
    }
    assert.deepEqual(result.os.cpus, [
      { model: 'unknown', speed: 1200, times: { idle: 0, irq: 0, nice: 0, sys: 0, user: 0 } }
    ])
    assert.deepEqual(result.os.networkInterfaces, {
      en0: [{
        address: '192.0.2.10',
        cidr: '192.0.2.10/24',
        family: 'IPv4',
        internal: false,
        mac: '02:00:00:00:00:01',
        netmask: '255.255.255.0'
      }]
    })
    assert.deepEqual(
      {
        arch: result.os.arch,
        availableParallelism: result.os.availableParallelism,
        freemem: result.os.freemem,
        homedir: result.os.homedir,
        hostname: result.os.hostname,
        loadavg: result.os.loadavg,
        machine: result.os.machine,
        releaseError: result.os.releaseError,
        tmpdir: result.os.tmpdir,
        totalmem: result.os.totalmem,
        uptime: result.os.uptime,
        userInfo: result.os.userInfo,
        version: result.os.version
      },
      {
        arch: 'arm64',
        availableParallelism: 4,
        freemem: 2_097_152,
        homedir: 'holo-fs://workspace/home',
        hostname: 'sandbox',
        loadavg: [0, 0.5, 1],
        machine: 'unknown',
        releaseError: { code: 'ERR_ACCESS_DENIED' },
        tmpdir: 'holo-fs://workspace/tmp',
        totalmem: 4_194_304,
        uptime: 3_600,
        userInfo: {
          gid: 1000,
          homedir: 'holo-fs://workspace/home',
          shell: 'holo-fs://workspace/bin/sh',
          uid: 1000,
          username: 'runtime-user'
        },
        version: '14'
      }
    )
    assert.ok([
      ['android', 'Android'],
      ['darwin', 'Darwin']
    ].some(([expectedPlatform, expectedType]) => (
      result.os.platform === expectedPlatform && result.os.type === expectedType
    )))
    assert.deepEqual(result.process, {
      cwd: 'holo-fs://workspace/',
      env: {},
      execPath: 'holo-fs://workspace/bin/holonomy',
      pid: 4242
    })
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes('do-not-leak'), false)
    assert.equal(serialized.includes('private-hostname'), false)
    assert.equal(serialized.includes('Host CPU Secret'), false)
  })
})
