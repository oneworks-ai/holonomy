const exact = mode => ({ allowedModes: [mode], maxPrecision: 'exact' })
const coarse = mode => ({ allowedModes: [mode], maxPrecision: 'coarse' })

export const systemInformationPolicy = Object.freeze({
  defaultMode: 'unavailable',
  fields: Object.freeze({
    'os.arch': exact('synthetic'),
    'os.availableParallelism': coarse('synthetic'),
    'os.cpus': coarse('synthetic'),
    'os.freemem': coarse('synthetic'),
    'os.homedir': exact('synthetic'),
    'os.hostname': { allowedModes: ['redacted'], maxPrecision: 'redacted' },
    'os.loadavg': coarse('synthetic'),
    'os.machine': coarse('synthetic'),
    'os.networkInterfaces': exact('synthetic'),
    'os.platform': exact('real'),
    'os.release': exact('synthetic'),
    'os.tmpdir': exact('synthetic'),
    'os.totalmem': coarse('synthetic'),
    'os.type': exact('synthetic'),
    'os.uptime': coarse('synthetic'),
    'os.userInfo': exact('synthetic'),
    'os.version': coarse('synthetic'),
    'process.cwd': exact('synthetic'),
    'process.env': { allowedModes: ['redacted'], maxPrecision: 'redacted' },
    'process.execPath': exact('synthetic'),
    'process.pid': exact('synthetic')
  })
})

export const createSystemProjectionFixture = ({ platform, type }) =>
  Object.freeze({
    fields: Object.freeze({
      'os.arch': { mode: 'synthetic', precision: 'exact', value: 'arm64' },
      'os.availableParallelism': { mode: 'synthetic', precision: 'coarse', value: 3 },
      'os.cpus': {
        mode: 'synthetic',
        precision: 'coarse',
        value: [{ model: 'Host CPU Secret', speed: 1234, times: { idle: 5, irq: 4, nice: 3, sys: 2, user: 1 } }]
      },
      'os.freemem': { mode: 'synthetic', precision: 'coarse', value: 3_000_000 },
      'os.homedir': { mode: 'synthetic', precision: 'exact', value: 'holo-fs://workspace/home' },
      'os.hostname': { mode: 'redacted', precision: 'redacted', value: 'private-hostname' },
      'os.loadavg': { mode: 'synthetic', precision: 'coarse', value: [0.2, 0.7, 1.2] },
      'os.machine': { mode: 'synthetic', precision: 'coarse', value: 'private-machine' },
      'os.networkInterfaces': {
        mode: 'synthetic',
        precision: 'exact',
        value: {
          en0: [{
            address: '192.0.2.10',
            cidr: '192.0.2.10/24',
            family: 'IPv4',
            internal: false,
            mac: '02:00:00:00:00:01',
            netmask: '255.255.255.0'
          }]
        }
      },
      'os.platform': { mode: 'real', precision: 'exact', value: platform },
      'os.release': { mode: 'unavailable', precision: 'none' },
      'os.tmpdir': { mode: 'synthetic', precision: 'exact', value: 'holo-fs://workspace/tmp' },
      'os.totalmem': { mode: 'synthetic', precision: 'coarse', value: 6_000_000 },
      'os.type': { mode: 'synthetic', precision: 'exact', value: type },
      'os.uptime': { mode: 'synthetic', precision: 'coarse', value: 7_199 },
      'os.userInfo': {
        mode: 'synthetic',
        precision: 'exact',
        value: {
          gid: 1000,
          homedir: 'holo-fs://workspace/home',
          shell: 'holo-fs://workspace/bin/sh',
          uid: 1000,
          username: 'runtime-user'
        }
      },
      'os.version': { mode: 'synthetic', precision: 'coarse', value: '14.5.1' },
      'process.cwd': { mode: 'synthetic', precision: 'exact', value: 'holo-fs://workspace/' },
      'process.env': { mode: 'redacted', precision: 'redacted', value: { HOST_SECRET: 'do-not-leak' } },
      'process.execPath': {
        mode: 'synthetic',
        precision: 'exact',
        value: 'holo-fs://workspace/bin/holonomy'
      },
      'process.pid': { mode: 'synthetic', precision: 'exact', value: 4242 }
    }),
    schemaVersion: 1
  })
