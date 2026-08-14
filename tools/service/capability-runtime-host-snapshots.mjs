import * as os from 'node:os'
import process from 'node:process'

const mapArchitecture = value => (
  ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64']
      .includes(value)
    ? value
    : 'unknown'
)
const mapPlatform = value => (
  ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'].includes(value)
    ? value
    : 'unknown'
)
const mapType = value => (
  ['AIX', 'Android', 'Darwin', 'FreeBSD', 'Linux', 'OpenBSD', 'SunOS', 'Windows_NT'].includes(value)
    ? value
    : 'unknown'
)

const VALUES = Object.freeze({
  'os.arch': () => mapArchitecture(os.arch()),
  'os.availableParallelism': () => 1,
  'os.cpus':
    () => [{ model: 'Holonomy Virtual CPU', speed: 1000, times: { idle: 0, irq: 0, nice: 0, sys: 0, user: 0 } }],
  'os.freemem': () => 0,
  'os.homedir': () => 'holo-fs://workspace/home',
  'os.hostname': () => 'holonomy-runtime',
  'os.loadavg': () => [0, 0, 0],
  'os.machine': () => mapArchitecture(os.machine?.() ?? os.arch()),
  'os.networkInterfaces': () => ({}),
  'os.platform': () => mapPlatform(os.platform()),
  'os.release': () => 'holonomy',
  'os.tmpdir': () => 'holo-fs://workspace/tmp',
  'os.totalmem': () => 0,
  'os.type': () => mapType(os.type()),
  'os.uptime': () => 0,
  'os.userInfo': () => ({
    gid: -1,
    homedir: 'holo-fs://workspace/home',
    shell: null,
    uid: -1,
    username: 'holonomy'
  }),
  'os.version': () => 'holonomy',
  'process.cwd': () => 'holo-fs://workspace/',
  'process.env': () => ({}),
  'process.execPath': () => 'holo-fs://workspace/bin/holonomy',
  'process.pid': () => 1
})

const projection = (field, ceiling) => {
  const value = VALUES[field]?.()
  if (value === undefined) return undefined
  if (ceiling.allowedModes.includes('synthetic')) {
    return { mode: 'synthetic', precision: ceiling.maxPrecision === 'coarse' ? 'coarse' : 'exact', value }
  }
  if (ceiling.allowedModes.includes('redacted')) {
    return { mode: 'redacted', precision: 'redacted', value }
  }
  return undefined
}

export const createDefaultHostSystemProjectionV1 = policy => ({
  fields: Object.fromEntries(
    Object.entries(policy.systemInformation.fields).flatMap(([field, ceiling]) => {
      const value = projection(field, ceiling)
      return value == null ? [] : [[field, value]]
    })
  ),
  schemaVersion: 1
})

const reading = (value, revision = 1) => ({
  observedAt: 0,
  precision: 'standard',
  revision,
  status: 'available',
  value
})
const missing = (revision = 1) => ({
  observedAt: 0,
  precision: 'none',
  revision,
  status: 'unsupported'
})

export const createDefaultNodeDeviceSnapshotV1 = () => {
  const formFactor = reading('server')
  const lifecycle = reading({ interactive: 'unknown', memoryPressure: 'unknown', visibility: 'foreground' })
  return {
    deviceReadings: {
      'device.form-factor.read': formFactor,
      'device.lifecycle.read': lifecycle
    },
    deviceSummary: {
      display: missing(),
      formFactor,
      input: missing(),
      lifecycle,
      power: missing(),
      schemaVersion: 1
    }
  }
}

export const createRealHostSystemProjectionV1 = () => ({
  fields: {
    'os.arch': { mode: 'real', precision: 'exact', value: mapArchitecture(os.arch()) },
    'os.platform': { mode: 'real', precision: 'exact', value: mapPlatform(process.platform) }
  },
  schemaVersion: 1
})
