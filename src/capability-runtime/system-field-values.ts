import { invalidPolicy } from './errors.js'
import type { SystemInformationFieldV1 } from './registry-types.js'
import type { SystemFieldValueMapV1 } from './system-types.js'
import {
  normalizeCpuList,
  normalizeInterfaces,
  normalizeLoadAverage,
  normalizeUserInfo,
  normalizeVirtualPath
} from './system-value-normalizers.js'
import { boundedText, finiteNumber, integer, literal, record, utf8ByteLength } from './validation.js'

const ARCH = [
  'arm',
  'arm64',
  'ia32',
  'loong64',
  'mips',
  'mipsel',
  'ppc',
  'ppc64',
  'riscv64',
  's390',
  's390x',
  'x64',
  'unknown'
] as const
const PLATFORM = [
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'unknown'
] as const
const TYPE = [
  'AIX',
  'Android',
  'Darwin',
  'FreeBSD',
  'Linux',
  'OpenBSD',
  'SunOS',
  'Windows_NT',
  'unknown'
] as const
const SAFE = Number.MAX_SAFE_INTEGER

const normalizeEnvironment = (value: unknown): Readonly<Record<string, string>> => {
  const input = record(value)
  const keys = Object.keys(input).sort()
  if (keys.length > 128) return invalidPolicy()
  let total = 0
  const output = Object.create(null) as Record<string, string>
  for (const key of keys) {
    if (!/^[A-Za-z_]\w*$/u.test(key)) return invalidPolicy()
    const item = boundedText(input[key], 65_536, true)
    total += utf8ByteLength(key) + utf8ByteLength(item)
    if (total > 65_536) return invalidPolicy()
    output[key] = item
  }
  return Object.freeze(output)
}

export const normalizeSystemFieldValue = <K extends SystemInformationFieldV1>(
  field: K,
  value: unknown
): SystemFieldValueMapV1[K] => {
  let result: unknown
  switch (field) {
    case 'os.arch':
      result = literal(value, ARCH)
      break
    case 'os.platform':
      result = literal(value, PLATFORM)
      break
    case 'os.type':
      result = literal(value, TYPE)
      break
    case 'os.machine':
      result = boundedText(value, 256)
      break
    case 'os.release':
    case 'os.version':
      result = boundedText(value, 1024)
      break
    case 'os.cpus':
      result = normalizeCpuList(value)
      break
    case 'os.availableParallelism':
    case 'process.pid':
      result = integer(value, 1, 1_048_576)
      break
    case 'os.totalmem':
    case 'os.freemem':
      result = integer(value, 0, SAFE)
      break
    case 'os.uptime':
      result = finiteNumber(value, 0, SAFE)
      break
    case 'os.loadavg':
      result = normalizeLoadAverage(value)
      break
    case 'os.hostname':
      result = boundedText(value, 256)
      break
    case 'os.networkInterfaces':
      result = normalizeInterfaces(value)
      break
    case 'os.userInfo':
      result = normalizeUserInfo(value)
      break
    case 'os.homedir':
    case 'os.tmpdir':
    case 'process.cwd':
    case 'process.execPath':
      result = normalizeVirtualPath(value)
      break
    case 'process.env':
      result = normalizeEnvironment(value)
      break
    default:
      return invalidPolicy()
  }
  return result as SystemFieldValueMapV1[K]
}
