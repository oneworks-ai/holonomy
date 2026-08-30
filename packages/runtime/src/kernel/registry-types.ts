export type SystemInformationFieldV1 =
  | 'os.arch'
  | 'os.availableParallelism'
  | 'os.cpus'
  | 'os.freemem'
  | 'os.homedir'
  | 'os.hostname'
  | 'os.loadavg'
  | 'os.machine'
  | 'os.networkInterfaces'
  | 'os.platform'
  | 'os.release'
  | 'os.tmpdir'
  | 'os.totalmem'
  | 'os.type'
  | 'os.uptime'
  | 'os.userInfo'
  | 'os.version'
  | 'process.cwd'
  | 'process.env'
  | 'process.execPath'
  | 'process.pid'

export type DeviceOperationV1 =
  | 'device.connectivity.cellular.state.read'
  | 'device.connectivity.read'
  | 'device.connectivity.wifi.identity.read'
  | 'device.connectivity.wifi.state.read'
  | 'device.display.read'
  | 'device.events.subscribe'
  | 'device.form-factor.read'
  | 'device.input.read'
  | 'device.lifecycle.read'
  | 'device.media.capabilities.read'
  | 'device.power.read'
  | 'device.security.capabilities.read'
  | 'device.sensor.capabilities.read'
  | 'device.summary.read'
  | 'device.thermal.read'

export type RuntimeObserverSelectableEventNameV1 =
  | 'gc.completed'
  | 'memory.pressure'
  | 'promise.rejected'
  | 'runtime.exception'
  | 'runtime.terminated'
  | 'script.compiled'
  | 'script.execution-finished'
  | 'script.execution-started'

export const SYSTEM_INFORMATION_FIELDS_V1 = Object.freeze(
  [
    'os.arch',
    'os.availableParallelism',
    'os.cpus',
    'os.freemem',
    'os.homedir',
    'os.hostname',
    'os.loadavg',
    'os.machine',
    'os.networkInterfaces',
    'os.platform',
    'os.release',
    'os.tmpdir',
    'os.totalmem',
    'os.type',
    'os.uptime',
    'os.userInfo',
    'os.version',
    'process.cwd',
    'process.env',
    'process.execPath',
    'process.pid'
  ] as const satisfies readonly SystemInformationFieldV1[]
)

export const DEVICE_OPERATIONS_V1 = Object.freeze(
  [
    'device.connectivity.cellular.state.read',
    'device.connectivity.read',
    'device.connectivity.wifi.identity.read',
    'device.connectivity.wifi.state.read',
    'device.display.read',
    'device.events.subscribe',
    'device.form-factor.read',
    'device.input.read',
    'device.lifecycle.read',
    'device.media.capabilities.read',
    'device.power.read',
    'device.security.capabilities.read',
    'device.sensor.capabilities.read',
    'device.summary.read',
    'device.thermal.read'
  ] as const satisfies readonly DeviceOperationV1[]
)

export const DEVICE_OPERATION_PRIVACY_TIER_V1 = Object.freeze(
  {
    'device.connectivity.cellular.state.read': 2,
    'device.connectivity.read': 2,
    'device.connectivity.wifi.identity.read': 3,
    'device.connectivity.wifi.state.read': 2,
    'device.display.read': 1,
    'device.events.subscribe': 0,
    'device.form-factor.read': 0,
    'device.input.read': 1,
    'device.lifecycle.read': 1,
    'device.media.capabilities.read': 2,
    'device.power.read': 1,
    'device.security.capabilities.read': 2,
    'device.sensor.capabilities.read': 2,
    'device.summary.read': 1,
    'device.thermal.read': 2
  } as const satisfies Readonly<Record<DeviceOperationV1, 0 | 1 | 2 | 3>>
)

export const OBSERVER_EVENTS_V1 = Object.freeze(
  [
    'gc.completed',
    'memory.pressure',
    'promise.rejected',
    'runtime.exception',
    'runtime.terminated',
    'script.compiled',
    'script.execution-finished',
    'script.execution-started'
  ] as const satisfies readonly RuntimeObserverSelectableEventNameV1[]
)
