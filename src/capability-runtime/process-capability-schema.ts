import type { JsonSchema } from './schema-primitives.js'
import { integerSchema, strictObject, stringSetSchema } from './schema-primitives.js'

const id: JsonSchema = {
  maxLength: 128,
  minLength: 1,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
  type: 'string'
}
const process = strictObject({
  executableIds: stringSetSchema(id, 0, 256),
  maxProcesses: integerSchema(0, 100_000),
  signals: stringSetSchema({ enum: ['SIGINT', 'SIGKILL', 'SIGTERM'] }, 0, 3)
})
const processLimits = strictObject({
  maxConcurrentProcesses: integerSchema(1, 64),
  maxExecutionTimeMs: integerSchema(1, 86_400_000),
  maxOpenPipes: integerSchema(0, 256),
  maxProcessTreeDepth: integerSchema(1, 32),
  maxStderrBytes: integerSchema(1, 16 * 1024 * 1024),
  maxStdinBytes: integerSchema(1, 16 * 1024 * 1024),
  maxStdoutBytes: integerSchema(1, 16 * 1024 * 1024),
  maxTotalProcesses: integerSchema(1, 100_000),
  maxWritableRootfsBytes: integerSchema(0, 4 * 1024 * 1024 * 1024)
})
const processExecution = strictObject({
  executableIds: stringSetSchema(id, 0, 256),
  limits: processLimits,
  rootIds: stringSetSchema(id, 0, 64)
})
const processShell = strictObject({ executableIds: stringSetSchema(id, 0, 256) })
const processSignal = strictObject({
  signals: stringSetSchema({ enum: ['SIGINT', 'SIGKILL', 'SIGTERM'] }, 0, 3)
})
const processNetwork = strictObject({
  endpoints: {
    items: strictObject({
      hostname: { maxLength: 253, minLength: 1, type: 'string' },
      ports: stringSetSchema(integerSchema(1, 65_535), 1, 64),
      transport: { enum: ['tcp', 'tls'] }
    }),
    maxItems: 256,
    type: 'array',
    uniqueItems: true
  },
  maxSockets: integerSchema(1, 256)
})

export const processCapabilityConstraintsSchema = (name: string): JsonSchema | undefined => {
  if (name === 'host.process.execute') return processExecution
  if (name === 'host.process.network') return processNetwork
  if (name === 'host.process.shell') return processShell
  if (name === 'host.process.signal') return processSignal
  if (name.startsWith('host.process.')) return process
  return undefined
}
