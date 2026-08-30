import {
  BINDING_SCHEMA_V1,
  IDENTIFIER_SCHEMA_V1,
  VIRTUAL_PATH_SCHEMA_V1
} from '@holonomyjs/runtime/kernel/registry-schema-primitives'
import type { JsonSchema } from '@holonomyjs/runtime/kernel/schema-primitives'
import { integerSchema, strictObject } from '@holonomyjs/runtime/kernel/schema-primitives'

const ARGUMENTS_SCHEMA_V1: JsonSchema = {
  items: { maxLength: 65_536, type: 'string' },
  maxItems: 4096,
  type: 'array'
}
const ENVIRONMENT_SCHEMA_V1: JsonSchema = {
  additionalProperties: { maxLength: 65_536, type: 'string' },
  maxProperties: 256,
  propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
  type: 'object'
}
const STDIO_SCHEMA_V1: JsonSchema = {
  items: false,
  maxItems: 3,
  minItems: 3,
  prefixItems: [
    { enum: ['ignore', 'pipe'] },
    { enum: ['ignore', 'pipe'] },
    { enum: ['ignore', 'pipe'] }
  ],
  type: 'array'
}
const COMMAND_SCHEMA_V1: JsonSchema = {
  maxLength: 16 * 1024 * 1024,
  minLength: 1,
  type: 'string'
}
const ENVIRONMENT_SCOPE_SCHEMA_V1: JsonSchema = { enum: ['processTree', 'runtime'] }

const SPAWN_OPTION_PROPERTIES_V1: Readonly<Record<string, JsonSchema>> = {
  cwd: VIRTUAL_PATH_SCHEMA_V1,
  env: ENVIRONMENT_SCHEMA_V1,
  signal: BINDING_SCHEMA_V1,
  stdio: STDIO_SCHEMA_V1,
  timeoutMs: integerSchema(1, 86_400_000)
}
const PROGRAM_SPAWN_OPTIONS_V1 = strictObject({
  ...SPAWN_OPTION_PROPERTIES_V1,
  shell: { const: false }
}, [])
const SHELL_SPAWN_OPTIONS_V1 = strictObject({
  ...SPAWN_OPTION_PROPERTIES_V1,
  shell: { const: true },
  shellExecutableId: IDENTIFIER_SCHEMA_V1
}, ['shell', 'shellExecutableId'])
const EXEC_OPTIONS_V1 = strictObject({
  cwd: VIRTUAL_PATH_SCHEMA_V1,
  encoding: { enum: ['buffer', 'utf8'] },
  env: ENVIRONMENT_SCHEMA_V1,
  maxBufferBytes: integerSchema(1, 16 * 1024 * 1024),
  signal: BINDING_SCHEMA_V1,
  timeoutMs: integerSchema(1, 86_400_000)
}, [])
const SHELL_EXEC_OPTIONS_V1 = strictObject({
  cwd: VIRTUAL_PATH_SCHEMA_V1,
  encoding: { enum: ['buffer', 'utf8'] },
  env: ENVIRONMENT_SCHEMA_V1,
  maxBufferBytes: integerSchema(1, 16 * 1024 * 1024),
  shellExecutableId: IDENTIFIER_SCHEMA_V1,
  signal: BINDING_SCHEMA_V1,
  timeoutMs: integerSchema(1, 86_400_000)
}, ['shellExecutableId'])

export const PROCESS_ARGUMENT_SCHEMAS_V1: Readonly<Record<string, JsonSchema>> = Object.freeze({
  ProcessDescendantAuthorizationArgsV1: strictObject({
    argv: {
      items: { maxLength: 4096, type: 'string' },
      maxItems: 256,
      minItems: 1,
      type: 'array'
    },
    cwd: { maxLength: 4096, minLength: 1, pattern: '^/', type: 'string' },
    environmentId: { maxLength: 256, minLength: 1, type: 'string' },
    environmentScope: ENVIRONMENT_SCOPE_SCHEMA_V1,
    executableId: IDENTIFIER_SCHEMA_V1,
    linuxPid: integerSchema(1, 0x7FFF_FFFF),
    parentLinuxPid: integerSchema(1, 0x7FFF_FFFF),
    path: { maxLength: 4096, minLength: 1, pattern: '^/', type: 'string' }
  }),
  ProcessNetworkAuthorizationArgsV1: strictObject({
    hostname: { maxLength: 253, minLength: 1, type: 'string' },
    port: integerSchema(1, 65_535),
    transport: { enum: ['tcp', 'tls', 'udp'] }
  }),
  ProcessExecArgsV1: strictObject({
    command: COMMAND_SCHEMA_V1,
    environmentScope: ENVIRONMENT_SCOPE_SCHEMA_V1,
    options: SHELL_EXEC_OPTIONS_V1
  }),
  ProcessExecFileArgsV1: strictObject({
    args: ARGUMENTS_SCHEMA_V1,
    environmentScope: ENVIRONMENT_SCOPE_SCHEMA_V1,
    executableId: IDENTIFIER_SCHEMA_V1,
    options: EXEC_OPTIONS_V1
  }, ['environmentScope', 'executableId']),
  ProcessProgramSpawnArgsV1: strictObject({
    args: ARGUMENTS_SCHEMA_V1,
    environmentScope: ENVIRONMENT_SCOPE_SCHEMA_V1,
    executableId: IDENTIFIER_SCHEMA_V1,
    options: PROGRAM_SPAWN_OPTIONS_V1
  }, ['environmentScope', 'executableId']),
  ProcessShellSpawnArgsV1: strictObject({
    command: COMMAND_SCHEMA_V1,
    environmentScope: ENVIRONMENT_SCOPE_SCHEMA_V1,
    options: SHELL_SPAWN_OPTIONS_V1
  })
})
