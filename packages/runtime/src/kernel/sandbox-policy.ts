import type { ProcessSandboxV2 } from '@holonomyjs/capability-process/kernel/policy-process-types'
import type {
  DeviceSandboxV2,
  DiagnosticsSandboxV2,
  SystemInformationSandboxV2
} from '@holonomyjs/capability-system/kernel/policy-host-types'
import type {
  CodeGenerationSandboxV2,
  FilesystemSandboxV2,
  InspectorSandboxV2,
  NetworkSandboxV2
} from './policy-types.js'

export interface SandboxPolicyV2 {
  readonly codeGeneration: CodeGenerationSandboxV2
  readonly device: DeviceSandboxV2
  readonly diagnostics: DiagnosticsSandboxV2
  readonly filesystem: FilesystemSandboxV2
  readonly inspector: InspectorSandboxV2
  readonly network: NetworkSandboxV2
  readonly process: ProcessSandboxV2
  readonly schemaVersion: 2
  readonly systemInformation: SystemInformationSandboxV2
}

export interface CompiledSandboxPolicyV2 {
  readonly canonicalJson: string
  readonly digest: string
  readonly policy: SandboxPolicyV2
}

/* eslint-disable perfectionist/sort-exports -- dprint owns mixed package/relative export order. */
export * from '@holonomyjs/capability-process/kernel/policy-process-types'
export * from '@holonomyjs/capability-system/kernel/policy-host-types'
export * from './policy-types.js'
/* eslint-enable perfectionist/sort-exports */
