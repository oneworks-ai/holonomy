import type { DeviceSandboxV2, DiagnosticsSandboxV2, SystemInformationSandboxV2 } from './policy-host-types.js'
import type { ProcessSandboxV2 } from './policy-process-types.js'
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

export * from './policy-host-types.js'
export * from './policy-process-types.js'
export * from './policy-types.js'
