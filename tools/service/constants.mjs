export const SERVICE_SCHEMA_VERSION = 1
export const SERVICE_API_VERSION = '1.0.0'

export const DEFAULT_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000
export const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024
export const HARD_MAX_REQUEST_BYTES = 8 * 1024 * 1024
export const PROCESS_START_MAX_REQUEST_BYTES = 64 * 1024 * 1024
export const DEFAULT_MAX_STATE_BYTES = 128 * 1024 * 1024
export const DEFAULT_MAX_EVENT_BYTES = 256 * 1024
export const DEFAULT_MAX_EVENTS_PER_READ = 256

export const PROCESS_STATES = Object.freeze([
  'cancelled',
  'exited',
  'failed',
  'lost',
  'queued',
  'running',
  'staging',
  'starting',
  'stopping',
  'waiting_for_debugger'
])

export const PROCESS_TERMINAL_STATES = new Set(['cancelled', 'exited', 'failed', 'lost'])
export const OPERATION_TERMINAL_STATES = new Set(['cancelled', 'failed', 'succeeded'])
export const INSPECTOR_TERMINAL_STATES = new Set(['closed', 'failed', 'lost'])
export const NETWORK_RULE_TERMINAL_STATES = new Set(['failed', 'removed'])

export const createInitialServiceState = () => ({
  cursor: 0,
  eventFloor: 0,
  idempotency: {},
  resources: {
    devices: {},
    inspectors: {},
    networkRules: {},
    operations: {},
    processes: {}
  },
  schemaVersion: SERVICE_SCHEMA_VERSION
})
