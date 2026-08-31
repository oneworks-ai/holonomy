export const digestInput = label => ['vector', label]

export const restrictedPolicyInput = Object.freeze({
  filesystem: {
    access: 'sandboxed',
    limits: {
      maxDirectoryEntries: 1000,
      maxOpenHandles: 32,
      maxQueuedEvents: 32,
      maxReadBytes: 1048576,
      maxWatchers: 8,
      maxWriteBytes: 1048576
    },
    roots: [{
      rights: ['write', 'read', 'list'],
      rootId: 'workspace',
      symlinks: 'withinRoot',
      virtualUrl: 'holo-fs://workspace/'
    }]
  },
  network: {
    access: 'restricted',
    allowedOrigins: ['https://api.example', 'http://127.0.0.1:8123'],
    allowedSchemes: ['https', 'http'],
    allowPrivateNetwork: true,
    limits: {
      maxChunkBytes: 65536,
      maxConcurrentConnections: 8,
      maxHeaderBytes: 65536,
      maxHeaders: 128,
      maxRedirects: 10,
      maxRequestBodyBytes: 1048576,
      maxResponseBodyBytes: 8388608,
      maxUrlBytes: 65536,
      socketTimeoutMs: 30000
    },
    requestBodyInspection: { access: 'none' }
  },
  schemaVersion: 2
})

export const systemProjectionInput = Object.freeze({
  fields: {
    'os.arch': { mode: 'real', precision: 'exact', value: 'arm64' },
    'os.availableParallelism': { mode: 'real', precision: 'coarse', value: 5 },
    'os.hostname': { mode: 'redacted', precision: 'redacted', value: 'host-secret' },
    'os.networkInterfaces': {
      mode: 'real',
      precision: 'coarse',
      value: {
        en0: [{
          address: '192.0.2.1',
          cidr: '192.0.2.1/24',
          family: 'IPv4',
          internal: false,
          mac: 'aa:bb:cc:dd:ee:ff',
          netmask: '255.255.255.0'
        }]
      }
    },
    'process.cwd': { mode: 'synthetic', precision: 'exact', value: 'holo-fs://workspace/' },
    'process.env': { mode: 'redacted', precision: 'redacted', value: { SECRET: 'value' } },
    'process.pid': { mode: 'redacted', precision: 'redacted', value: 9000 }
  },
  schemaVersion: 1
})

export const deviceSummaryInput = Object.freeze({
  display: {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: {
      hdr: 'unknown',
      heightCssPx: 800,
      orientation: 'portrait',
      scale: 2,
      wideColor: 'unknown',
      widthCssPx: 400
    }
  },
  formFactor: {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: 'phone'
  },
  input: {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: {
      hover: false,
      keyboard: false,
      maxTouchPoints: 5,
      mouse: false,
      pointer: 'coarse',
      touch: true
    }
  },
  lifecycle: {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: { interactive: true, memoryPressure: 'normal', visibility: 'foreground' }
  },
  power: {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: {
      charging: true,
      hasBattery: true,
      levelPercent: 80,
      lowPowerMode: false,
      source: 'usb'
    }
  },
  schemaVersion: 1
})
