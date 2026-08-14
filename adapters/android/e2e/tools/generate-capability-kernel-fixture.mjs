import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { NodeProcessBackendRegistryV1 } from '../../../../adapters/node/src/capability-process-backend.mjs'
import { createV86ProcessBackendV1 } from '../../../../adapters/node/src/capability-process-v86-backend.mjs'
import { createServiceCapabilityRuntimeManagerV1 } from '../../../../tools/service/capability-runtime-manager.mjs'
import { compileSandboxPolicy } from '../../../../tools/service/sandbox-policy.mjs'

const ENTRY_URL = 'fixture+session://runtime/capability-kernel-v1.mjs'
const MOCK_ORIGIN = 'https://mock.example'
const MOCK_URL = `${MOCK_ORIGIN}/profile`
const PROCESS_ID = 'process_android_capability_fixture'
const PROCESS_NETWORK_PORT = 18_086
const V86_ASSET_ROOT = process.env.HOLO_V86_PROBE_ASSET_ROOT
const V86_ENABLED = typeof V86_ASSET_ROOT === 'string' && V86_ASSET_ROOT !== ''

const networkLimits = Object.freeze({
  maxChunkBytes: 65_536,
  maxConcurrentConnections: 8,
  maxHeaderBytes: 65_536,
  maxHeaders: 128,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 8 * 1024 * 1024,
  maxUrlBytes: 65_536,
  socketTimeoutMs: 30_000
})

const processPolicy = !V86_ENABLED
  ? Object.freeze({ access: 'none' })
  : Object.freeze({
    access: 'sandboxed',
    environment: Object.freeze({ allowedNames: Object.freeze([]), maxValueBytes: 1 }),
    executables: Object.freeze([Object.freeze({
      argumentBytes: 4_096,
      executableId: 'android-v86-selftest'
    })]),
    limits: Object.freeze({
      maxConcurrentProcesses: 1,
      maxExecutionTimeMs: 120_000,
      maxOpenPipes: 3,
      maxProcessTreeDepth: 1,
      maxStderrBytes: 4_096,
      maxStdinBytes: 4_096,
      maxStdoutBytes: 65_536,
      maxTotalProcesses: 2,
      maxWritableRootfsBytes: 4_096
    }),
    mounts: Object.freeze([Object.freeze({
      guestPath: '/workspace',
      rights: Object.freeze(['read', 'write']),
      rootId: 'workspace'
    })]),
    network: Object.freeze({
      access: 'restricted',
      endpoints: Object.freeze([Object.freeze({
        hostname: '127.0.0.1',
        ports: Object.freeze([PROCESS_NETWORK_PORT]),
        transport: 'tcp'
      })]),
      maxSockets: 1
    }),
    shell: Object.freeze({ access: 'none' })
  })

const capabilityPolicy = Object.freeze({
  device: Object.freeze({
    defaultAccess: 'deny',
    maxEventsPerSecond: 1,
    maxSubscriptions: 0,
    operations: Object.freeze({
      'device.form-factor.read': Object.freeze({
        access: 'allow',
        maxPrecision: 'standard',
        maxPrivacyTier: 0
      }),
      'device.power.read': Object.freeze({
        access: 'allow',
        maxPrecision: 'standard',
        maxPrivacyTier: 1
      })
    })
  }),
  filesystem: Object.freeze({
    access: 'sandboxed',
    limits: Object.freeze({
      maxDirectoryEntries: 32,
      maxOpenHandles: 8,
      maxReadBytes: 4096,
      maxWatchers: 0,
      maxWriteBytes: 4096
    }),
    roots: Object.freeze([Object.freeze({
      rights: Object.freeze(['read', 'write']),
      rootId: 'workspace',
      symlinks: 'deny',
      virtualUrl: 'holo-fs://workspace/'
    })])
  }),
  network: Object.freeze({
    access: 'mockOnly',
    allowedOrigins: Object.freeze([MOCK_ORIGIN]),
    allowedSchemes: Object.freeze(['https']),
    allowPrivateNetwork: false,
    limits: Object.freeze({ ...networkLimits, maxRedirects: 10 }),
    requestBodyInspection: Object.freeze({ access: 'none' })
  }),
  process: processPolicy,
  schemaVersion: 2,
  systemInformation: Object.freeze({
    defaultMode: 'unavailable',
    fields: Object.freeze({
      'os.arch': Object.freeze({ allowedModes: Object.freeze(['synthetic']), maxPrecision: 'exact' })
    })
  })
})

const source = `
  import { readFile, readFileSync, writeFile, writeFileSync } from 'node:fs'
  import { readFile as readFilePromise } from 'node:fs/promises'
  import { arch } from 'node:os'
  import { getFormFactor, getPower } from 'holo:device'
  import { getContext } from 'holo:runtime'

  writeFileSync('holo-fs://workspace/input.txt', 'android-guest-input', 'utf8')
  const callbackValue = await new Promise((resolve, reject) => {
    readFile('holo-fs://workspace/input.txt', 'utf8', (error, value) => error ? reject(error) : resolve(value))
  })
  const writeCallbackArity = await new Promise((resolve, reject) => {
    writeFile('holo-fs://workspace/output.txt', 'android-capability-output', 'utf8', function(error) {
      if (error) reject(error)
      else resolve(arguments.length)
    })
  })
  const codeGeneration = {
    evalBlocked: false,
    functionBlocked: false,
    wasmUnavailable: typeof WebAssembly === 'undefined'
  }
  try { eval('1'); } catch { codeGeneration.evalBlocked = true }
  try { Function('return 1')(); } catch { codeGeneration.functionBlocked = true }
  const response = await fetch('${MOCK_URL}')
  let linuxFilesystem
  try {
    const bridgeResult = await globalThis.__oneworksHolonomy.exerciseLinuxFilesystemBridge()
    linuxFilesystem = {
      ...bridgeResult,
      output: readFileSync('holo-fs://workspace/linux-output.txt', 'utf8')
    }
  } catch (error) {
    linuxFilesystem = { error: { code: error?.code, message: error?.message, name: error?.name } }
  }
  const archValue = arch()
  const deviceValue = getFormFactor()
  const powerValue = getPower()
  console.log('M25_ANDROID:' + JSON.stringify({
    arch: archValue,
    callbackValue,
    codeGeneration,
    context: getContext(),
    device: deviceValue,
    mockBody: await response.text(),
    linuxFilesystem,
    power: powerValue,
    promiseValue: await readFilePromise('holo-fs://workspace/input.txt', 'utf8'),
    syncValue: readFileSync('holo-fs://workspace/input.txt', 'utf8'),
    writeCallbackArity
  }))
`

const legacyPolicy = compileSandboxPolicy({
  filesystem: { access: 'none' },
  network: {
    access: 'mockOnly',
    allowedOrigins: [MOCK_ORIGIN],
    allowedSchemes: ['https'],
    allowPrivateNetwork: false,
    limits: networkLimits
  },
  schemaVersion: 1
}).policy

const sha256 = file => createHash('sha256').update(readFileSync(resolve(V86_ASSET_ROOT, file))).digest('hex')

const v86Profile = () => ({
  backend: {
    backendId: 'experimental.v86-v1',
    configuration: {
      artifacts: {
        bios: { artifactId: 'seabios.bin', sha256: sha256('seabios.bin') },
        initrd: { artifactId: 'supervisor.cpio', sha256: sha256('supervisor.cpio') },
        kernel: { artifactId: 'kernel.bin', sha256: sha256('kernel.bin') },
        wasm: { artifactId: 'v86.wasm', sha256: sha256('v86.wasm') }
      },
      memoryBytes: 128 * 1024 * 1024,
      requiredKernelCapabilities: ['process', 'fuse', 'tun'],
      supervisor: { protocolVersion: 1 }
    }
  },
  environment: { allowedScopes: ['runtime'], defaultScope: 'runtime' },
  executables: [{
    executable: { kind: 'guestPath', path: '/holo-selftest' },
    executableId: 'android-v86-selftest',
    fixedArgs: [],
    shell: false
  }],
  profile: 'process-profile-v1'
})

const v86Registry = () =>
  new NodeProcessBackendRegistryV1([
    createV86ProcessBackendV1({
      environmentFactory: { open: () => Promise.reject(new Error('Descriptor-only Android Backend')) },
      handleFilesystemRequest: () => Promise.reject(new Error('Descriptor-only Android Backend')),
      handleNetworkRequest: () => Promise.reject(new Error('Descriptor-only Android Backend'))
    })
  ])

export const generateCapabilityKernelFixture = async () => {
  const launch = {
    entryUrl: ENTRY_URL,
    moduleRootUrl: 'fixture+session://runtime/',
    modules: [{ source, url: ENTRY_URL }],
    schemaVersion: 2,
    target: 'android'
  }
  const manager = createServiceCapabilityRuntimeManagerV1(
    V86_ENABLED
      ? {
        processBackendRegistry: v86Registry(),
        processProfiles: { 'android-v86': v86Profile() }
      }
      : {}
  )
  const admitted = manager.admit({
    context: {
      guest: { application: { id: 'android.capability.fixture', name: 'Android Capability Fixture' } },
      host: { tenantId: 'android-private-tenant' },
      inspector: { title: 'Android Capability Inspector' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    ...(V86_ENABLED ? { processProfileId: 'android-v86' } : {}),
    sandboxPolicy: capabilityPolicy,
    schemaVersion: 1
  }, {
    entryUrl: ENTRY_URL,
    inspectorMode: 'off',
    launch,
    sandboxPolicy: legacyPolicy,
    target: 'android'
  })
  const capabilityRuntime = await manager.prepare({
    capabilityRuntime: admitted,
    entryUrl: ENTRY_URL,
    generation: 1,
    id: PROCESS_ID,
    inspectorMode: 'off',
    launch,
    sandboxPolicy: legacyPolicy,
    target: 'android'
  })
  return Object.freeze({
    bytes: Buffer.from(
      `${JSON.stringify({ capabilityRuntime, entryUrl: ENTRY_URL, processId: PROCESS_ID, source })}\n`
    ),
    path: 'runtime/capability-kernel-v1.json',
    source: 'generated:service-capability-runtime-manager-v1'
  })
}
