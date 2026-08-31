import type {
  DeviceOperationV1,
  RuntimeObserverSelectableEventNameV1,
  SystemInformationFieldV1
} from '@holonomyjs/runtime/kernel/registry-types'

export type SystemExposedProjectionModeV1 = 'real' | 'redacted' | 'synthetic'

export interface SystemFieldCeilingV1 {
  readonly allowedModes: readonly SystemExposedProjectionModeV1[]
  readonly maxPrecision?: 'coarse' | 'exact' | 'redacted'
}

export interface SystemInformationSandboxV2 {
  readonly defaultMode: 'unavailable'
  readonly fields: Readonly<Partial<Record<SystemInformationFieldV1, SystemFieldCeilingV1>>>
}

export interface DeviceGrantCeilingV1 {
  readonly access: 'allow'
  readonly maxPrecision: 'coarse' | 'exact' | 'standard'
  readonly maxPrivacyTier: 0 | 1 | 2 | 3
}

export interface DeviceSandboxV2 {
  readonly defaultAccess: 'deny'
  readonly maxEventsPerSecond: number
  readonly maxQueuedEvents: number
  readonly maxSubscriptions: number
  readonly operations: Readonly<Partial<Record<DeviceOperationV1, DeviceGrantCeilingV1>>>
}

export interface DiagnosticsSandboxV2 {
  readonly maxObserverCallbackMs: number
  readonly maxQueuedEvents: number
  readonly maxSourceReadBytes: number
  readonly observerEvents: readonly RuntimeObserverSelectableEventNameV1[]
  readonly retentionMs: number
  readonly sourceReader: 'boundedSource' | 'metadataOnly' | 'none'
}
