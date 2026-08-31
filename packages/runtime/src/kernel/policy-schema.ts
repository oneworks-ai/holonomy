import { FILESYSTEM_SANDBOX_V2_SCHEMA } from '@holonomyjs/capability-fs/kernel/policy-schema-filesystem'
import { NETWORK_SANDBOX_V2_SCHEMA } from '@holonomyjs/capability-network/kernel/policy-schema-network'
import { PROCESS_SANDBOX_V2_SCHEMA } from '@holonomyjs/capability-process/kernel/policy-schema-process'
import {
  DEVICE_SANDBOX_V2_SCHEMA,
  DIAGNOSTICS_SANDBOX_V2_SCHEMA,
  SYSTEM_INFORMATION_SANDBOX_V2_SCHEMA
} from '@holonomyjs/capability-system/kernel/policy-schema-host'
import { CODE_GENERATION_SANDBOX_V2_SCHEMA, INSPECTOR_SANDBOX_V2_SCHEMA } from './policy-schema-code.js'
import { strictObject } from './schema-primitives.js'

export const SANDBOX_POLICY_V2_SCHEMA = Object.freeze({
  $id: 'https://holonomy.dev/schemas/sandbox-policy-v2.json',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  ...strictObject({
    codeGeneration: CODE_GENERATION_SANDBOX_V2_SCHEMA,
    device: DEVICE_SANDBOX_V2_SCHEMA,
    diagnostics: DIAGNOSTICS_SANDBOX_V2_SCHEMA,
    filesystem: FILESYSTEM_SANDBOX_V2_SCHEMA,
    inspector: INSPECTOR_SANDBOX_V2_SCHEMA,
    network: NETWORK_SANDBOX_V2_SCHEMA,
    process: PROCESS_SANDBOX_V2_SCHEMA,
    schemaVersion: { const: 2 },
    systemInformation: SYSTEM_INFORMATION_SANDBOX_V2_SCHEMA
  }, ['schemaVersion'])
})
