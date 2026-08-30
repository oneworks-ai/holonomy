/* eslint-disable max-lines -- The generated cross-realm conformance program stays as one auditable source template. */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

import { NodeProcessBackendRegistryV1 } from '../../../../adapters/node/src/capability-process-backend.mjs'
import { createV86ProcessBackendV1 } from '../../../../adapters/node/src/capability-process-v86-backend.mjs'
import {
  createSystemProjectionFixture,
  systemInformationPolicy
} from '../../../../conformance/capabilities/system-projection-fixture.mjs'
import { createServiceCapabilityRuntimeManagerV1 } from '../../../../tools/service/capability-runtime-manager.mjs'
import { compileSandboxPolicy } from '../../../../tools/service/sandbox-policy.mjs'

const ENTRY_URL = 'fixture+session://runtime/capability-kernel-v1.mjs'
const FILESYSTEM_CONFORMANCE_URL = 'fixture+session://runtime/conformance/filesystem-v1.test.mjs'
const FILESYSTEM_GENERATION_ENTRY_URL = 'fixture+session://runtime/filesystem-generation-v1.mjs'
const NETWORK_CONTINUATION_ENTRY_URL = 'fixture+session://runtime/capability-network-continuation-v1.mjs'
const NETWORK_PRIVATE_DENY_ENTRY_URL = 'fixture+session://runtime/capability-network-private-deny-v1.mjs'
const NETWORK_REAL_ENTRY_URL = 'fixture+session://runtime/capability-network-real-v1.mjs'
const PROCESS_CONFORMANCE_URL = 'fixture+session://runtime/conformance/process-v86.test.mjs'
const SYSTEM_CONFORMANCE_URL = 'fixture+session://runtime/conformance/system-projection.test.mjs'
const MOCK_ORIGIN = 'https://mock.example'
const MOCK_URL = `${MOCK_ORIGIN}/profile`
const PRIVATE_DENY_ORIGIN = 'http://ip6-localhost:2'
const REAL_ORIGIN = 'http://127.0.0.1:18087'
const V86_TCP_PORT = 18088
const V86_UDP_PORT = 18089
const PROCESS_ID = 'process_android_capability_fixture'
const NETWORK_CONTINUATION_PROCESS_ID = 'process_android_network_continuation_fixture'
const NETWORK_PRIVATE_DENY_PROCESS_ID = 'process_android_network_private_deny_fixture'
const NETWORK_REAL_PROCESS_ID = 'process_android_network_real_fixture'
const FILESYSTEM_GENERATION_PROCESS_ID = 'process_android_filesystem_generation_fixture'
const V86_ASSET_ROOT = process.env.HOLO_V86_PROBE_ASSET_ROOT
const V86_ENABLED = typeof V86_ASSET_ROOT === 'string' && V86_ASSET_ROOT !== ''
const processConformanceSource = V86_ENABLED
  ? readFileSync(new URL('../../../../conformance/capabilities/process-v86.test.mjs', import.meta.url), 'utf8')
  : null
const filesystemConformanceSource = readFileSync(
  new URL('../../../../conformance/capabilities/filesystem-v1.test.mjs', import.meta.url),
  'utf8'
)
const systemConformanceSource = readFileSync(
  new URL('../../../../conformance/capabilities/system-projection.test.mjs', import.meta.url),
  'utf8'
)
const systemProjection = createSystemProjectionFixture({ platform: 'android', type: 'Android' })

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
    executables: Object.freeze([
      'holo-v86-cat',
      'holo-v86-curl',
      'holo-v86-hoholo',
      'holo-v86-nc',
      'holo-v86-shell',
      'holo-v86-timeout'
    ].map(executableId => Object.freeze({ argumentBytes: 4_096, executableId }))),
    limits: Object.freeze({
      maxConcurrentProcesses: 1,
      maxExecutionTimeMs: 120_000,
      maxOpenPipes: 3,
      maxProcessTreeDepth: 2,
      maxStderrBytes: 4_096,
      maxStdinBytes: 4_096,
      maxStdoutBytes: 65_536,
      maxTotalProcesses: 16,
      maxWritableRootfsBytes: 4_096
    }),
    mounts: Object.freeze([Object.freeze({
      guestPath: '/workspace',
      rights: Object.freeze(['read', 'write']),
      rootId: 'workspace'
    })]),
    network: Object.freeze({
      access: 'restricted',
      endpoints: Object.freeze([
        Object.freeze({ hostname: 'android-v86.test', ports: Object.freeze([V86_TCP_PORT]), transport: 'tcp' }),
        Object.freeze({ hostname: 'android-v86.test', ports: Object.freeze([V86_UDP_PORT]), transport: 'udp' })
      ]),
      maxSockets: 2
    }),
    shell: Object.freeze({ access: 'none' })
  })

const deviceOperation = maxPrivacyTier =>
  Object.freeze({
    access: 'allow',
    maxPrecision: 'standard',
    maxPrivacyTier
  })

const capabilityPolicy = Object.freeze({
  device: Object.freeze({
    defaultAccess: 'deny',
    maxEventsPerSecond: 16,
    maxQueuedEvents: 8,
    maxSubscriptions: 2,
    operations: Object.freeze({
      'device.connectivity.cellular.state.read': deviceOperation(2),
      'device.connectivity.read': deviceOperation(2),
      'device.connectivity.wifi.state.read': deviceOperation(2),
      'device.display.read': deviceOperation(1),
      'device.events.subscribe': deviceOperation(2),
      'device.form-factor.read': deviceOperation(0),
      'device.input.read': deviceOperation(1),
      'device.lifecycle.read': deviceOperation(1),
      'device.power.read': deviceOperation(1),
      'device.summary.read': deviceOperation(1)
    })
  }),
  filesystem: Object.freeze({
    access: 'sandboxed',
    limits: Object.freeze({
      maxDirectoryEntries: 32,
      maxOpenHandles: 8,
      maxQueuedEvents: 8,
      maxReadBytes: 4096,
      maxWatchers: 2,
      maxWriteBytes: 4096
    }),
    roots: Object.freeze([Object.freeze({
      rights: Object.freeze(['create', 'delete', 'list', 'move', 'read', 'watch', 'write']),
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
  systemInformation: systemInformationPolicy
})

const networkContinuationPolicy = Object.freeze({
  ...capabilityPolicy,
  filesystem: Object.freeze({ access: 'none' }),
  process: Object.freeze({ access: 'none' })
})

const networkPrivateDenyPolicy = Object.freeze({
  ...networkContinuationPolicy,
  network: Object.freeze({
    access: 'restricted',
    allowedOrigins: Object.freeze([PRIVATE_DENY_ORIGIN]),
    allowedSchemes: Object.freeze(['http']),
    allowPrivateNetwork: false,
    limits: Object.freeze({ ...networkLimits, maxRedirects: 10 }),
    requestBodyInspection: Object.freeze({ access: 'none' })
  })
})

const networkRealPolicy = Object.freeze({
  ...networkContinuationPolicy,
  network: Object.freeze({
    access: 'restricted',
    allowedOrigins: Object.freeze([REAL_ORIGIN]),
    allowedSchemes: Object.freeze(['http']),
    allowPrivateNetwork: true,
    limits: Object.freeze({ ...networkLimits, maxRedirects: 10 }),
    requestBodyInspection: Object.freeze({ access: 'none' })
  })
})

const source = `
  import ${JSON.stringify(FILESYSTEM_CONFORMANCE_URL)}
  import ${JSON.stringify(SYSTEM_CONFORMANCE_URL)}
  ${V86_ENABLED ? `import ${JSON.stringify(PROCESS_CONFORMANCE_URL)}` : ''}
  import { run as runTests } from 'node:test'
  import * as fsNamespace from 'node:fs'
  import {
    close,
    closeSync,
    lstat,
    lstatSync,
    mkdir,
    mkdirSync,
    open,
    openSync,
    readFile,
    readFileSync,
    readdir,
    readdirSync,
    rename,
    renameSync,
    stat,
    unlink,
    unlinkSync,
    watch,
    writeFile,
    writeFileSync
  } from 'node:fs'
  import * as fsPromisesNamespace from 'node:fs/promises'
  import {
    lstat as lstatPromise,
    mkdir as mkdirPromise,
    open as openPromise,
    readFile as readFilePromise,
    readdir as readdirPromise,
    rename as renamePromise,
    stat as statPromise,
    unlink as unlinkPromise,
    watch as watchPromise,
    writeFile as writeFilePromise
  } from 'node:fs/promises'
  import { arch } from 'node:os'
  import {
    getCellularState,
    getConnectivity,
    getDisplay,
    getFormFactor,
    getInput,
    getLifecycle,
    getPower,
    getSummary,
    getWifiState
  } from 'holo:device'
  import { getSummary as getSummaryPromise, subscribe } from 'holo:device/promises'
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
  const fsDirectory = mkdirSync('holo-fs://workspace/m3/deep', { recursive: true })
  writeFileSync('holo-fs://workspace/m3/deep/handle.txt', 'handle-before', 'utf8')
  const fd = openSync('holo-fs://workspace/m3/deep/handle.txt', 'r')
  const fdText = readFileSync(fd, 'utf8')
  closeSync(fd)
  const writableFd = openSync('holo-fs://workspace/m3/deep/fd-write.txt', 'w+')
  writeFileSync(writableFd, 'fd-write', 'utf8')
  closeSync(writableFd)
  const fdWriteText = readFileSync('holo-fs://workspace/m3/deep/fd-write.txt', 'utf8')
  unlinkSync('holo-fs://workspace/m3/deep/fd-write.txt')
  const readHandle = await openPromise('holo-fs://workspace/m3/deep/handle.txt', 'r')
  const handleRead = await readHandle.readFile('utf8')
  await readHandle.close()
  const fileHandle = await openPromise('holo-fs://workspace/m3/deep/handle.txt', 'r+')
  await fileHandle.writeFile('handle-after')
  const handleStat = await fileHandle.stat()
  await fileHandle.close()
  await mkdirPromise('holo-fs://workspace/m3/promise-dir', { recursive: true })
  writeFileSync('holo-fs://workspace/m3/promise-dir/listed.txt', 'listed')
  const promiseDirents = await readdirPromise('holo-fs://workspace/m3/promise-dir', { withFileTypes: true })
  const promiseLstat = await lstatPromise('holo-fs://workspace/m3/promise-dir/listed.txt')
  unlinkSync('holo-fs://workspace/m3/promise-dir/listed.txt')
  await writeFilePromise('holo-fs://workspace/m3/deep/promise.txt', 'promise-value')
  await renamePromise(
    'holo-fs://workspace/m3/deep/promise.txt',
    'holo-fs://workspace/m3/deep/promise-moved.txt'
  )
  const promiseStat = await statPromise('holo-fs://workspace/m3/deep/promise-moved.txt')
  const promiseText = await readFilePromise('holo-fs://workspace/m3/deep/promise-moved.txt', 'utf8')
  await unlinkPromise('holo-fs://workspace/m3/deep/promise-moved.txt')
  renameSync(
    'holo-fs://workspace/m3/deep/handle.txt',
    'holo-fs://workspace/m3/deep/renamed.txt'
  )
  const fsNames = readdirSync('holo-fs://workspace/m3/deep')
  const fsDirents = readdirSync('holo-fs://workspace/m3/deep', { withFileTypes: true })
  const lstatFile = lstatSync('holo-fs://workspace/m3/deep/renamed.txt').isFile()
  const callback = start => new Promise((resolve, reject) => start(function(error, value) {
    if (error) reject(error)
    else resolve({ arity: arguments.length, value })
  }))
  const callbackDirectory = await callback(done => mkdir(
    'holo-fs://workspace/m3/callback-dir',
    { recursive: true },
    done
  ))
  writeFileSync('holo-fs://workspace/m3/callback-dir/opened.txt', 'callback-open')
  const callbackOpen = await callback(done => open(
    'holo-fs://workspace/m3/callback-dir/opened.txt',
    'r',
    done
  ))
  const callbackFdText = readFileSync(callbackOpen.value, 'utf8')
  const callbackClose = await callback(done => close(callbackOpen.value, done))
  const callbackStat = await callback(done => stat('holo-fs://workspace/m3/callback-dir/opened.txt', done))
  const callbackLstat = await callback(done => lstat('holo-fs://workspace/m3/callback-dir/opened.txt', done))
  const callbackReaddir = await callback(done => readdir(
    'holo-fs://workspace/m3/callback-dir',
    { withFileTypes: true },
    done
  ))
  const callbackRename = await callback(done => rename(
    'holo-fs://workspace/m3/callback-dir/opened.txt',
    'holo-fs://workspace/m3/callback-dir/renamed.txt',
    done
  ))
  const callbackUnlink = await callback(done => unlink('holo-fs://workspace/m3/callback-dir/renamed.txt', done))
  const watchEvent = await new Promise((resolve, reject) => {
    const watcher = watch('holo-fs://workspace/m3/deep', {
      maxQueuedEvents: 1,
      persistent: false
    }, (type, filename) => {
      watcher.close()
      resolve({ filename, maxQueuedEvents: watcher.maxQueuedEvents, type })
    })
    watcher.on('error', reject)
    setTimeout(() => writeFileSync('holo-fs://workspace/m3/deep/watched.txt', 'watched'), 20)
  })
  const watchIterator = watchPromise('holo-fs://workspace/m3/deep', {
    maxQueuedEvents: 1,
    persistent: false
  })
  const nextWatchEvent = watchIterator.next()
  setTimeout(() => writeFileSync('holo-fs://workspace/m3/deep/iterator.txt', 'iterator'), 20)
  const iteratorEvent = await nextWatchEvent
  const iteratorDone = await watchIterator.return()
  const staleFd = openSync('holo-fs://workspace/input.txt', 'r')
  closeSync(staleFd)
  let staleFdCode
  try { readFileSync(staleFd) } catch (error) { staleFdCode = error.code }
  const quotaHandles = []
  let handleLimitCode
  try {
    for (let index = 0; index < 9; index += 1) {
      quotaHandles.push(openSync('holo-fs://workspace/input.txt', 'r'))
    }
  } catch (error) {
    handleLimitCode = error.code
  } finally {
    for (const handle of quotaHandles) closeSync(handle)
  }
  let byteLimitCode
  try { writeFileSync('holo-fs://workspace/m3/oversize.txt', 'x'.repeat(4097)) }
  catch (error) { byteLimitCode = error.code }
  writeFileSync('holo-fs://workspace/m3/atomic.txt', 'before')
  let exclusiveCode
  try {
    writeFileSync('holo-fs://workspace/m3/atomic.txt', 'after', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    exclusiveCode = error.code
  }
  const atomicRollback = readFileSync('holo-fs://workspace/m3/atomic.txt', 'utf8')
  unlinkSync('holo-fs://workspace/m3/atomic.txt')
  const promiseAbortController = new AbortController()
  promiseAbortController.abort()
  let promiseAbort
  try {
    await readFilePromise(
      'holo-fs://workspace/input.txt',
      { encoding: 'utf8', signal: promiseAbortController.signal }
    )
  } catch (error) {
    promiseAbort = { code: error.code, name: error.name }
  }
  const writeAbortController = new AbortController()
  writeAbortController.abort()
  let writeAbort
  try {
    await writeFilePromise(
      'holo-fs://workspace/m3/aborted.txt',
      'must-not-exist',
      { signal: writeAbortController.signal }
    )
  } catch (error) {
    writeAbort = { code: error.code, name: error.name }
  }
  let abortedWriteCode
  try { readFileSync('holo-fs://workspace/m3/aborted.txt') }
  catch (error) { abortedWriteCode = error.code }
  const callbackAbortController = new AbortController()
  callbackAbortController.abort()
  let callbackAbortCalls = 0
  const callbackAbort = await new Promise(resolve => readFile(
    'holo-fs://workspace/input.txt',
    { encoding: 'utf8', signal: callbackAbortController.signal },
    function(error) {
      callbackAbortCalls += 1
      resolve({ args: arguments.length, code: error.code, name: error.name })
    }
  ))
  unlinkSync('holo-fs://workspace/m3/deep/renamed.txt')
  unlinkSync('holo-fs://workspace/m3/deep/watched.txt')
  unlinkSync('holo-fs://workspace/m3/deep/iterator.txt')
  const filesystemM3 = {
    abortedWriteCode,
    atomicRollback,
    byteLimitCode,
    callbackAbort,
    callbackAbortCalls,
    callbackArities: [
      callbackDirectory.arity,
      callbackOpen.arity,
      callbackClose.arity,
      callbackStat.arity,
      callbackLstat.arity,
      callbackReaddir.arity,
      callbackRename.arity,
      callbackUnlink.arity
    ],
    callbackFdText,
    callbackMetadata: callbackStat.value.isFile() && callbackLstat.value.isFile(),
    callbackReaddir: callbackReaddir.value.map(entry => [entry.name, entry.isFile()]),
    directory: fsDirectory ?? null,
    dirents: fsDirents.map(entry => [entry.name, entry.isFile()]),
    fdText,
    fdWriteText,
    exclusiveCode,
    handleRead,
    handleLimitCode,
    handleSize: handleStat.size,
    iteratorDone: iteratorDone.done,
    iteratorEvent: iteratorEvent.value,
    iteratorMaxQueuedEvents: watchIterator.maxQueuedEvents,
    lstatFile,
    names: fsNames,
    promiseDirectory: promiseDirents.map(entry => [entry.name, entry.isFile()]),
    promiseFile: promiseStat.isFile(),
    promiseLstat: promiseLstat.isFile(),
    promiseAbort,
    promiseText,
    staleFdCode,
    unsupportedExports: [
      typeof fsNamespace.realpathSync,
      typeof fsNamespace.createReadStream,
      typeof fsPromisesNamespace.opendir
    ],
    watchEvent,
    writeAbort
  }
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
  const deviceSubscription = await subscribe({ kinds: ['connectivity', 'display', 'lifecycle', 'power'] })
  const deviceEvents = []
  for (let index = 0; index < 4; index += 1) deviceEvents.push((await deviceSubscription.next()).value)
  await deviceSubscription.return()
  const boundedDeviceSubscription = await subscribe({
    kinds: ['connectivity', 'display', 'lifecycle', 'power'],
    maxQueuedEvents: 1
  })
  // Let the Host-posted baseline events fill the bounded queue before the
  // consumer asks for the first item. A waiting next() receives events
  // directly and therefore, correctly, does not count as queue pressure.
  await new Promise(resolve => setTimeout(resolve, 0))
  const deviceOverflow = (await boundedDeviceSubscription.next()).value
  const resyncRevisions = {
    connectivity: getConnectivity().revision,
    display: getDisplay().revision,
    lifecycle: getLifecycle().revision,
    power: getPower().revision
  }
  let invalidResyncCode
  try {
    await boundedDeviceSubscription.acknowledgeResync({
      ...resyncRevisions,
      display: resyncRevisions.display + 1
    })
  } catch (error) {
    invalidResyncCode = error.code
  }
  await boundedDeviceSubscription.acknowledgeResync(resyncRevisions)
  await boundedDeviceSubscription.return()
  const deviceM3 = {
    cellular: getCellularState(),
    connectivity: getConnectivity(),
    display: getDisplay(),
    events: deviceEvents,
    input: getInput(),
    invalidResyncCode,
    lifecycle: getLifecycle(),
    maxQueuedEvents: boundedDeviceSubscription.maxQueuedEvents,
    overflow: deviceOverflow,
    summary: getSummary(),
    summaryPromise: await getSummaryPromise(),
    wifi: getWifiState()
  }
  const guestSummary = await runTests()
  if (guestSummary.failed !== 0) throw new Error('Guest capability conformance failed')
  const guestConformance = {
    failed: guestSummary.failed,
    passed: guestSummary.passed,
    total: guestSummary.total
  }
  const mockBody = await response.text()
  console.log('M25_ANDROID:' + JSON.stringify({
    arch: archValue,
    callbackValue,
    codeGeneration,
    context: getContext(),
    device: deviceValue,
    deviceM3,
    filesystemM3,
    guestConformance,
    mockBody,
    linuxFilesystem,
    power: powerValue,
    promiseValue: await readFilePromise('holo-fs://workspace/input.txt', 'utf8'),
    syncValue: readFileSync('holo-fs://workspace/input.txt', 'utf8'),
    writeCallbackArity
  }))
`

const networkContinuationSource = `
  const redirected = await fetch('${MOCK_ORIGIN}/redirect')
  const clone = redirected.clone()
  const first = await redirected.text()
  const second = await clone.text()

  const controller = new AbortController()
  const pending = fetch('${MOCK_ORIGIN}/slow', { signal: controller.signal })
  controller.abort()
  let cancelCode
  try {
    await pending
    cancelCode = 'leaked'
  } catch (error) {
    cancelCode = error?.code ?? error?.message ?? 'unknown'
  }

  let websocket
  try {
    new WebSocket('wss://api.example/socket')
    websocket = { leaked: true }
  } catch (error) {
    websocket = { message: error.message, name: error.name }
  }

  console.log('M3_NETWORK_ANDROID:' + JSON.stringify({
    cancelCode,
    first,
    redirected: redirected.redirected,
    second,
    websocket
  }))
`

const networkPrivateDenySource = `
  let code = 'leaked'
  try {
    await fetch('${PRIVATE_DENY_ORIGIN}/private')
  } catch (error) {
    code = error?.code ?? error?.message ?? 'unknown'
  }
  console.log('M3_NETWORK_PRIVATE_ANDROID:' + JSON.stringify({ code }))
`

const networkRealSource = `
  const response = await fetch('${REAL_ORIGIN}/real')
  console.log('M3_NETWORK_REAL_ANDROID:' + JSON.stringify({
    body: await response.text(),
    status: response.status
  }))
`

const filesystemGenerationSource = `
  import { mkdirSync, watch } from 'node:fs'
  const directory = 'holo-fs://workspace/generation-watch'
  mkdirSync(directory, { recursive: true })
  watch(directory, { persistent: false }, () => console.log('M3_FS_GENERATION_EVENT'))
  console.log('M3_FS_GENERATION_READY')
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

const privateDenyLegacyPolicy = compileSandboxPolicy({
  filesystem: { access: 'none' },
  network: {
    access: 'restricted',
    allowedOrigins: [PRIVATE_DENY_ORIGIN],
    allowedSchemes: ['http'],
    allowPrivateNetwork: false,
    limits: networkLimits
  },
  schemaVersion: 1
}).policy

const realLegacyPolicy = compileSandboxPolicy({
  filesystem: { access: 'none' },
  network: {
    access: 'restricted',
    allowedOrigins: [REAL_ORIGIN],
    allowedSchemes: ['http'],
    allowPrivateNetwork: true,
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
        initrd: { artifactId: 'agent.cpio', sha256: sha256('agent.cpio') },
        kernel: { artifactId: 'kernel.bin', sha256: sha256('kernel.bin') },
        wasm: { artifactId: 'v86.wasm', sha256: sha256('v86.wasm') }
      },
      memoryBytes: 128 * 1024 * 1024,
      requiredKernelCapabilities: ['process', 'fuse', 'seccompUserNotification'],
      supervisor: { execGateTimeoutMs: 30_000, protocolVersion: 1 }
    }
  },
  environment: { allowedScopes: ['runtime'], defaultScope: 'runtime' },
  executables: [
    ['holo-v86-shell', '/bin/sh'],
    ['holo-v86-cat', '/bin/cat'],
    ['holo-v86-curl', '/usr/bin/curl'],
    ['holo-v86-hoholo', '/usr/bin/hoholo'],
    ['holo-v86-nc', '/usr/bin/nc'],
    ['holo-v86-timeout', '/usr/bin/timeout']
  ].map(([executableId, path]) => ({
    executable: { kind: 'guestPath', path },
    executableId,
    fixedArgs: [],
    shell: false
  })),
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
  const modules = [
    { source, url: ENTRY_URL },
    { source: filesystemConformanceSource, url: FILESYSTEM_CONFORMANCE_URL },
    { source: systemConformanceSource, url: SYSTEM_CONFORMANCE_URL },
    ...(processConformanceSource == null
      ? []
      : [{ source: processConformanceSource, url: PROCESS_CONFORMANCE_URL }])
  ]
  const launch = {
    entryUrl: ENTRY_URL,
    moduleRootUrl: 'fixture+session://runtime/',
    modules,
    schemaVersion: 2,
    target: 'android'
  }
  const manager = createServiceCapabilityRuntimeManagerV1({
    systemProjectionFactory: () => systemProjection,
    ...(V86_ENABLED
      ? {
        processBackendInstallations: {
          'experimental.v86-v1': {
            artifactRoot: resolve(V86_ASSET_ROOT),
            backendId: 'experimental.v86-v1',
            implementation: 'builtin.v86-v1'
          }
        },
        processBackendRegistry: v86Registry(),
        processProfiles: { 'android-v86': v86Profile() }
      }
      : {})
  })
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
      `${JSON.stringify({ capabilityRuntime, entryUrl: ENTRY_URL, modules, processId: PROCESS_ID })}\n`
    ),
    path: 'runtime/capability-kernel-v1.json',
    source: 'generated:service-capability-runtime-manager-v1'
  })
}

const generateNetworkFixture = async ({
  applicationId,
  applicationName,
  entryUrl,
  legacySandboxPolicy,
  path,
  processId,
  sandboxPolicy,
  source
}) => {
  const modules = [{ source, url: entryUrl }]
  const launch = {
    entryUrl,
    moduleRootUrl: 'fixture+session://runtime/',
    modules,
    schemaVersion: 2,
    target: 'android'
  }
  const manager = createServiceCapabilityRuntimeManagerV1({
    systemProjectionFactory: () => systemProjection
  })
  const admitted = manager.admit({
    context: {
      guest: {
        application: {
          id: applicationId,
          name: applicationName
        }
      },
      host: { tenantId: 'android-private-tenant' },
      inspector: { title: 'Android Network Continuation Inspector' },
      schemaVersion: 1
    },
    initialMiddlewareId: 'service.continue.v1',
    sandboxPolicy,
    schemaVersion: 1
  }, {
    entryUrl,
    inspectorMode: 'off',
    launch,
    sandboxPolicy: legacySandboxPolicy,
    target: 'android'
  })
  const capabilityRuntime = await manager.prepare({
    capabilityRuntime: admitted,
    entryUrl,
    generation: 1,
    id: processId,
    inspectorMode: 'off',
    launch,
    sandboxPolicy: legacySandboxPolicy,
    target: 'android'
  })
  return Object.freeze({
    bytes: Buffer.from(
      `${
        JSON.stringify({
          capabilityRuntime,
          entryUrl,
          modules,
          processId
        })
      }\n`
    ),
    path,
    source: 'generated:service-capability-runtime-manager-v1'
  })
}

export const generateCapabilityNetworkContinuationFixture = () =>
  generateNetworkFixture({
    applicationId: 'android.network.continuation.fixture',
    applicationName: 'Android Network Continuation Fixture',
    entryUrl: NETWORK_CONTINUATION_ENTRY_URL,
    legacySandboxPolicy: legacyPolicy,
    path: 'runtime/capability-network-continuation-v1.json',
    processId: NETWORK_CONTINUATION_PROCESS_ID,
    sandboxPolicy: networkContinuationPolicy,
    source: networkContinuationSource
  })

export const generateCapabilityNetworkPrivateDenyFixture = () =>
  generateNetworkFixture({
    applicationId: 'android.network.private-deny.fixture',
    applicationName: 'Android Network Private Deny Fixture',
    entryUrl: NETWORK_PRIVATE_DENY_ENTRY_URL,
    legacySandboxPolicy: privateDenyLegacyPolicy,
    path: 'runtime/capability-network-private-deny-v1.json',
    processId: NETWORK_PRIVATE_DENY_PROCESS_ID,
    sandboxPolicy: networkPrivateDenyPolicy,
    source: networkPrivateDenySource
  })

export const generateCapabilityNetworkRealFixture = () =>
  generateNetworkFixture({
    applicationId: 'android.network.real.fixture',
    applicationName: 'Android Network Real Fixture',
    entryUrl: NETWORK_REAL_ENTRY_URL,
    legacySandboxPolicy: realLegacyPolicy,
    path: 'runtime/capability-network-real-v1.json',
    processId: NETWORK_REAL_PROCESS_ID,
    sandboxPolicy: networkRealPolicy,
    source: networkRealSource
  })

export const generateCapabilityFilesystemGenerationFixture = () =>
  generateNetworkFixture({
    applicationId: 'android.filesystem.generation.fixture',
    applicationName: 'Android Filesystem Generation Fixture',
    entryUrl: FILESYSTEM_GENERATION_ENTRY_URL,
    legacySandboxPolicy: legacyPolicy,
    path: 'runtime/capability-filesystem-generation-v1.json',
    processId: FILESYSTEM_GENERATION_PROCESS_ID,
    sandboxPolicy: Object.freeze({ ...capabilityPolicy, process: Object.freeze({ access: 'none' }) }),
    source: filesystemGenerationSource
  })
