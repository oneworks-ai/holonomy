import { SYSTEM_INFORMATION_FIELDS_V1 } from './registry-types.js'
import { integerSchema, strictObject } from './schema-primitives.js'
import type { JsonSchema } from './schema-primitives.js'

const boundedString = (maxLength: number, minLength = 1): JsonSchema => ({ maxLength, minLength, type: 'string' })
const finiteNumber: JsonSchema = { maximum: Number.MAX_SAFE_INTEGER, minimum: 0, type: 'number' }
const safeInteger = integerSchema(0, Number.MAX_SAFE_INTEGER)
const path: JsonSchema = { maxLength: 4096, pattern: '^holo-fs://[a-z][\\w.-]{0,63}/', type: 'string' }

const cpu = strictObject({
  model: boundedString(256),
  speed: integerSchema(0, 10_000_000),
  times: strictObject({ idle: safeInteger, irq: safeInteger, nice: safeInteger, sys: safeInteger, user: safeInteger })
})
const address = strictObject({
  address: boundedString(64),
  cidr: { anyOf: [{ type: 'null' }, boundedString(72)] },
  family: { enum: ['IPv4', 'IPv6'] },
  internal: { type: 'boolean' },
  mac: { pattern: '^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$', type: 'string' },
  netmask: boundedString(64),
  scopeid: integerSchema(0, 0xFFFF_FFFF)
}, ['address', 'cidr', 'family', 'internal', 'mac', 'netmask'])
const userInfo = strictObject({
  gid: integerSchema(-1, Number.MAX_SAFE_INTEGER),
  homedir: path,
  shell: { anyOf: [{ type: 'null' }, path] },
  uid: integerSchema(-1, Number.MAX_SAFE_INTEGER),
  username: boundedString(256)
})

export const SYSTEM_FIELD_VALUE_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  'os.arch': {
    enum: [
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
    ]
  },
  'os.availableParallelism': integerSchema(1, 1_048_576),
  'os.cpus': { items: cpu, maxItems: 256, type: 'array' },
  'os.freemem': safeInteger,
  'os.homedir': path,
  'os.hostname': boundedString(256),
  'os.loadavg': { items: finiteNumber, maxItems: 3, minItems: 3, type: 'array' },
  'os.machine': boundedString(256),
  'os.networkInterfaces': {
    additionalProperties: { items: address, maxItems: 16, type: 'array' },
    maxProperties: 32,
    type: 'object'
  },
  'os.platform': { enum: ['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'unknown'] },
  'os.release': boundedString(1024),
  'os.tmpdir': path,
  'os.totalmem': safeInteger,
  'os.type': { enum: ['AIX', 'Android', 'Darwin', 'FreeBSD', 'Linux', 'OpenBSD', 'SunOS', 'Windows_NT', 'unknown'] },
  'os.uptime': finiteNumber,
  'os.userInfo': userInfo,
  'os.version': boundedString(1024),
  'process.cwd': path,
  'process.env': {
    additionalProperties: { maxLength: 65_536, type: 'string' },
    maxProperties: 128,
    propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
    type: 'object'
  },
  'process.execPath': path,
  'process.pid': integerSchema(1, 1_048_576)
})

const projectionFor = (field: string): JsonSchema => ({
  oneOf: [
    strictObject({
      mode: { enum: ['real', 'synthetic'] },
      precision: { enum: ['coarse', 'exact'] },
      value: SYSTEM_FIELD_VALUE_SCHEMAS_V1[field]!
    }),
    strictObject({
      mode: { const: 'redacted' },
      precision: { const: 'redacted' },
      value: SYSTEM_FIELD_VALUE_SCHEMAS_V1[field]!
    }),
    strictObject({ mode: { const: 'unavailable' }, precision: { const: 'none' } })
  ]
})

export const HOST_SYSTEM_PROJECTION_V1_SCHEMA = strictObject({
  fields: {
    additionalProperties: false,
    properties: Object.fromEntries(SYSTEM_INFORMATION_FIELDS_V1.map(field => [field, projectionFor(field)])),
    type: 'object'
  },
  schemaVersion: { const: 1 }
})
