import type { SystemInformationFieldV1 } from './registry-types.js'
import type { NodeCpuInfoV1, NodeNetworkInterfaceInfoV1, SystemFieldValueMapV1 } from './system-types.js'

const powerOfTwoDown = (value: number): number => {
  if (value <= 0) return 0
  return 2 ** Math.floor(Math.log2(value))
}

const powerOfTwoUp = (value: number): number => {
  if (value <= 1) return 1
  return Math.min(1_048_576, 2 ** Math.ceil(Math.log2(value)))
}

const majorFamily = (value: string): string => /^\d+/u.exec(value)?.[0] ?? 'unknown'

const coarseCpu = (value: NodeCpuInfoV1): NodeCpuInfoV1 =>
  Object.freeze({
    model: 'unknown',
    speed: Math.round(value.speed / 100) * 100,
    times: Object.freeze({ idle: 0, irq: 0, nice: 0, sys: 0, user: 0 })
  })

const coarseInterfaces = (
  value: SystemFieldValueMapV1['os.networkInterfaces']
): SystemFieldValueMapV1['os.networkInterfaces'] => {
  const output = Object.create(null) as Record<string, readonly NodeNetworkInterfaceInfoV1[]>
  Object.keys(value).sort().forEach((key, index) => {
    output[`interface-${index + 1}`] = Object.freeze(value[key]!.map(item =>
      Object.freeze({
        address: item.family === 'IPv4' ? '0.0.0.0' : '::',
        cidr: null,
        family: item.family,
        internal: item.internal,
        mac: '00:00:00:00:00:00',
        netmask: item.family === 'IPv4' ? '0.0.0.0' : '::'
      })
    ))
  })
  return Object.freeze(output)
}

const redactedValue = <K extends SystemInformationFieldV1>(field: K): SystemFieldValueMapV1[K] => {
  let value: unknown
  switch (field) {
    case 'os.arch':
    case 'os.machine':
    case 'os.platform':
    case 'os.release':
    case 'os.type':
    case 'os.version':
      value = 'unknown'
      break
    case 'os.cpus':
      value = Object.freeze([])
      break
    case 'os.availableParallelism':
    case 'process.pid':
      value = 1
      break
    case 'os.totalmem':
    case 'os.freemem':
    case 'os.uptime':
      value = 0
      break
    case 'os.loadavg':
      value = Object.freeze([0, 0, 0])
      break
    case 'os.hostname':
      value = 'sandbox'
      break
    case 'os.networkInterfaces':
    case 'process.env':
      value = Object.freeze(Object.create(null))
      break
    case 'os.userInfo':
      value = Object.freeze({
        gid: -1,
        homedir: 'holo-fs://workspace/',
        shell: null,
        uid: -1,
        username: 'sandbox'
      })
      break
    case 'os.homedir':
    case 'process.cwd':
      value = 'holo-fs://workspace/'
      break
    case 'os.tmpdir':
      value = 'holo-fs://tmp/'
      break
    case 'process.execPath':
      value = 'holo-fs://runtime/holonomy'
      break
  }
  return value as SystemFieldValueMapV1[K]
}

export const coarseSystemFieldValue = <K extends SystemInformationFieldV1>(
  field: K,
  input: SystemFieldValueMapV1[K]
): SystemFieldValueMapV1[K] => {
  let value: unknown = input
  switch (field) {
    case 'os.machine':
      value = 'unknown'
      break
    case 'os.release':
    case 'os.version':
      value = majorFamily(input as string)
      break
    case 'os.cpus':
      value = Object.freeze((input as readonly NodeCpuInfoV1[]).map(coarseCpu))
      break
    case 'os.availableParallelism':
      value = powerOfTwoUp(input as number)
      break
    case 'os.totalmem':
    case 'os.freemem':
      value = powerOfTwoDown(input as number)
      break
    case 'os.uptime':
      value = Math.floor((input as number) / 3600) * 3600
      break
    case 'os.loadavg':
      value = Object.freeze((input as readonly number[]).map(item => (
        Math.round(item * 2) / 2
      )))
      break
    case 'os.networkInterfaces':
      value = coarseInterfaces(
        input as SystemFieldValueMapV1['os.networkInterfaces']
      )
      break
    case 'os.hostname':
    case 'os.userInfo':
    case 'process.pid':
      value = redactedValue(field)
      break
  }
  return value as SystemFieldValueMapV1[K]
}

export const redactSystemFieldValue = redactedValue
