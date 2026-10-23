/* eslint-disable max-lines -- one native child record owns output, terminal and stop fencing. */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { serviceError } from './errors.mjs'
import { NativeInspectorConnection } from './native-inspector-transport.mjs'
import { materializeNativeLaunch } from './native-launch-materialization.mjs'
import { NativeOutputPool } from './native-output-pool.mjs'
import {
  MAX_NATIVE_PLUGIN_GENERATION_BYTES,
  MAX_NATIVE_PLUGIN_GENERATION_GRAPHS,
  materializeNativePluginGraph,
  replaceNativePluginConfig
} from './native-plugin-materialization.mjs'
import { validateNativeExecutable } from './native-runtime-installation.mjs'
import { processIsRunning } from './process-identity.mjs'
import { readBoundedRegularFile } from './secure-file-read.mjs'
import { createNativeLocalAdapter } from './target-adapters.mjs'
import { requireIdentifier, requireInteger } from './validation.mjs'

const MAX_CHUNK = 16 * 1024
const MAX_PRIVATE_LAUNCH_BYTES = 1024 * 1024
const processRootPath = (root, process) => join(root, requireIdentifier(process.id, 'Native process id'))

const createPrivateInspector = async process => {
  if (process.inspectorMode === 'off' || process.inspectorMode == null) return undefined
  const directory = join(await realpath('/tmp'), `holo-i-${randomBytes(16).toString('hex')}`)
  await mkdir(directory, { mode: 0o700 })
  const socketPath = join(directory, 'cdp.sock')
  if (Buffer.byteLength(socketPath) > 100) {
    await rm(directory, { force: true, recursive: true })
    throw serviceError('service.unavailable', 'Native Inspector socket path is too long')
  }
  const identity = await lstat(directory)
  return Object.freeze({ directory, device: identity.dev, inode: identity.ino, socketPath })
}

const releasePrivateInspector = async privateInspector => {
  if (privateInspector == null) return
  const identity = await lstat(privateInspector.directory).catch(() => undefined)
  if (identity?.isDirectory() && identity.dev === privateInspector.device && identity.ino === privateInspector.inode) {
    await rm(privateInspector.directory, { force: true, recursive: true })
  }
}

const storedPrivateInspector = async (root, process) => {
  try {
    const bytes = await readBoundedRegularFile(
      join(processRootPath(root, process), `g${process.generation}`, 'host', 'inspector-owner.json'),
      { label: 'Native Inspector ownership', maxBytes: 4_096, ownerOnly: true }
    )
    const marker = JSON.parse(bytes.toString('utf8'))
    const temporaryRoot = await realpath('/tmp')
    if (
      marker.schemaVersion !== 1 || marker.processId !== process.id ||
      marker.generation !== process.generation ||
      typeof marker.directory !== 'string' ||
      !/^holo-i-[a-f\d]{32}$/u.test(marker.directory.slice(temporaryRoot.length + 1)) ||
      !marker.directory.startsWith(`${temporaryRoot}/`) ||
      !Number.isSafeInteger(marker.device) || !Number.isSafeInteger(marker.inode)
    ) return undefined
    return marker
  } catch {
    return undefined
  }
}

const childIdentityPath = (root, process) =>
  join(
    processRootPath(root, process),
    `g${requireInteger(process.generation, 'Native generation', { min: 1 })}`,
    'host',
    'child.json'
  )

const recoveredChildExited = async (root, process) => {
  try {
    const bytes = await readBoundedRegularFile(childIdentityPath(root, process), {
      label: 'Native child identity',
      maxBytes: 4_096,
      ownerOnly: true
    })
    const identity = JSON.parse(bytes.toString('utf8'))
    return identity.processId === process.id && identity.generation === process.generation &&
      Number.isSafeInteger(identity.pid) && identity.pid > 0 && !processIsRunning(identity.pid)
  } catch {
    return false
  }
}

const requireRecord = (records, process) => {
  const record = records.get(process.id)
  if (record == null || record.generation !== process.generation) {
    throw serviceError('service.not_found', 'Native Runtime generation was not found')
  }
  return record
}

const pushOutput = (record, stream, value) => {
  for (let offset = 0; offset < value.length; offset += MAX_CHUNK) {
    record.outputPool.append(record, stream, value.slice(offset, offset + MAX_CHUNK))
  }
}

const publishTerminal = (record, code, signal) => {
  if (record.stopping || record.terminal != null) return
  const succeeded = code === 0 && signal == null && record.reportInvalid !== true
  record.terminal = Object.freeze({
    exit: { code: succeeded ? 0 : Number.isInteger(code) ? code : 1, reason: succeeded ? 'completed' : 'failed' },
    generation: record.generation,
    state: succeeded ? 'exited' : 'failed'
  })
  for (const listener of [...record.listeners]) {
    try {
      listener(record.terminal)
    } catch {
      record.listeners.delete(listener)
    }
  }
}

const renderTap = report => {
  const lines = ['TAP version 13']
  report.results.forEach((result, index) => {
    const name = [...result.path, result.name].join(' > ')
    if (result.status === 'passed') lines.push(`ok ${index + 1} - ${name}`)
    else if (result.status === 'skipped') lines.push(`ok ${index + 1} - ${name} # SKIP platform`)
    else {lines.push(
        `not ok ${index + 1} - ${name}\n  ---\n  message: ${JSON.stringify(result.failure?.message)}\n  ...`
      )}
  })
  lines.push(
    `1..${report.results.length}`,
    `# tests ${report.total}`,
    `# pass ${report.passed}`,
    `# fail ${report.failed}`,
    `# common ${report.common.passed}/${report.common.total}`
  )
  return `${lines.join('\n')}\n`
}

const emitTestCandidate = record => {
  const candidate = record.testCandidate?.trim()
  if (candidate == null || candidate.length === 0) {
    record.reportInvalid = true
    return
  }
  let report
  try {
    report = JSON.parse(candidate)
  } catch {
    report = undefined
  }
  if (
    report == null || !Array.isArray(report.results) || !Number.isSafeInteger(report.total) ||
    !Number.isSafeInteger(report.passed) || !Number.isSafeInteger(report.failed) ||
    !Number.isSafeInteger(report.common?.passed) || !Number.isSafeInteger(report.common?.total) ||
    report.results.some(result => !Array.isArray(result.path) || typeof result.name !== 'string')
  ) {
    pushOutput(record, 'stdout', record.testCandidate)
    record.reportInvalid = true
    return
  }
  pushOutput(record, 'stdout', record.reporter === 'json' ? `${candidate}\n` : renderTap(report))
  pushOutput(record, 'stdout', `# holonomy-result ${candidate}\n`)
}

const collect = (record, pipe, stream) => {
  const decoder = new StringDecoder('utf8')
  const accept = value => {
    if (stream !== 'stdout' || record.command !== 'test') {
      pushOutput(record, stream, value)
      return
    }
    record.testBuffer += value
    if (record.testBuffer.length > 1024 * 1024) {
      record.reportInvalid = true
      pushOutput(record, 'stderr', 'Native test report exceeds the Service limit\n')
      record.testBuffer = ''
      return
    }
    while (true) {
      const end = record.testBuffer.indexOf('\n')
      if (end < 0) break
      const line = record.testBuffer.slice(0, end + 1)
      record.testBuffer = record.testBuffer.slice(end + 1)
      if (record.testCandidate != null) pushOutput(record, 'stdout', record.testCandidate)
      record.testCandidate = line
    }
  }
  pipe.on('data', chunk => accept(decoder.write(chunk)))
  pipe.once('end', () => {
    accept(decoder.end())
    if (record.command === 'test' && stream === 'stdout') {
      if (record.testBuffer !== '') {
        if (record.testCandidate != null) pushOutput(record, 'stdout', record.testCandidate)
        record.testCandidate = record.testBuffer
      }
      emitTestCandidate(record)
    }
  })
}

const stopRecord = async (record, { terminalOnClose = false } = {}) => {
  record.inspectorConnection?.close()
  if (record.closed) {
    await record.inspectorCleanup
    return
  }
  if (record.stopPromise != null) return await record.stopPromise
  record.terminalOnClose = terminalOnClose
  record.stopping = true
  record.rejectAck?.(serviceError('service.precondition_failed', 'Native Runtime is stopping'))
  record.stopPromise = (async () => {
    record.child.stdin.end()
    const force = setTimeout(() => record.child.kill('SIGKILL'), 2_000)
    let deadline
    try {
      await Promise.race([
        record.exited,
        new Promise((_, reject) => {
          deadline = setTimeout(() =>
            reject(
              serviceError('service.unavailable', 'Native cleanup is still pending', {
                details: { cleanupPending: true }
              })
            ), 3_000)
        })
      ])
    } finally {
      clearTimeout(force)
      clearTimeout(deadline)
      if (!record.terminalOnClose || record.closed) record.listeners.clear()
      if (record.closed) await record.inspectorCleanup
    }
  })()
  return await record.stopPromise
}

export const privateLaunchLine = (process, launch, privateInspector) => {
  const managedPlugins = process.launch.command === 'run' || process.runtimePlugins != null ||
    process.capabilityRuntime?.initialObserverIds?.length > 0 || launch.hostConfig?.diagnosticAudit != null
  const privateLaunch = {
    argv: process.launch.argv.slice(1),
    entry: launch.entryPath,
    workspaceRoot: launch.workspaceRoot,
    generation: 1,
    hostConfig: launch.hostConfig,
    ...(launch.processProfilesManifest == null
      ? {}
      : { processProfilesManifest: launch.processProfilesManifest }),
    moduleAllowlist: launch.moduleAllowlist,
    ...(launch.moduleAliases.length === 0 ? {} : { moduleAliases: launch.moduleAliases }),
    ...(launch.moduleMetadataOnly.length === 0
      ? {}
      : { moduleMetadataOnly: launch.moduleMetadataOnly }),
    schemaVersion: launch.moduleMetadataOnly.length > 0 ? 4 : launch.moduleAliases.length === 0 ? 2 : 3,
    testMode: process.launch.command === 'test',
    timeout: null,
    watchConfig: managedPlugins && process.launch.command === 'run' ? launch.hostConfigPath : null,
    ...(privateInspector == null
      ? {}
      : {
        inspectorSocket: privateInspector.socketPath,
        inspectorWaitForDebugger: process.inspectorMode === 'break'
      }),
    ...(managedPlugins
      ? {
        servicePluginConfig: launch.hostConfigPath,
        servicePluginRevision: process.pluginGraphRevision ?? 0
      }
      : {})
  }
  const line = `${JSON.stringify(privateLaunch)}\n`
  if (Buffer.byteLength(line, 'utf8') > MAX_PRIVATE_LAUNCH_BYTES) {
    throw serviceError('service.limit_exceeded', 'Native private launch exceeds the Host limit')
  }
  return line
}

const installAcknowledgements = record => {
  const pipe = record.child.stdio?.[3]
  if (pipe == null) throw serviceError('service.unavailable', 'Native plugin acknowledgement pipe is unavailable')
  record.ackBuffer = ''
  record.ackWaiter = undefined
  record.earlyAcks = new Map()
  record.rejectAck = error => {
    const waiter = record.ackWaiter
    if (waiter == null) return
    record.ackWaiter = undefined
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }
  pipe.on('data', chunk => {
    record.ackBuffer += chunk.toString('utf8')
    if (record.ackBuffer.length > 4096) {
      record.rejectAck(serviceError('service.unavailable', 'Native acknowledgement exceeded the limit'))
      record.ackBuffer = ''
      return
    }
    while (true) {
      const end = record.ackBuffer.indexOf('\n')
      if (end < 0) break
      const line = record.ackBuffer.slice(0, end)
      record.ackBuffer = record.ackBuffer.slice(end + 1)
      let ack
      try {
        ack = JSON.parse(line)
      } catch {
        ack = undefined
      }
      const waiter = record.ackWaiter
      if (waiter == null || ack?.event !== waiter.event || ack.revision !== waiter.revision) {
        if (ack?.event === 'ready' && ack.revision === record.pluginRevision) {
          record.earlyAcks.set(`ready:${ack.revision}`, ack)
        }
        continue
      }
      record.ackWaiter = undefined
      clearTimeout(waiter.timer)
      if (ack.applied === true) waiter.resolve()
      else waiter.reject(serviceError('service.conflict', 'Native plugin graph was rejected'))
    }
  })
  pipe.once('end', () => record.rejectAck(serviceError('service.unavailable', 'Native acknowledgement pipe closed')))
}

const waitForAck = (record, event, revision) => {
  if (record.closed || record.stopping || record.ackWaiter != null) {
    throw serviceError('service.precondition_failed', 'Native plugin update cannot start')
  }
  const early = record.earlyAcks?.get(`${event}:${revision}`)
  if (early != null) {
    record.earlyAcks.delete(`${event}:${revision}`)
    if (early.applied === true) return Promise.resolve()
    return Promise.reject(serviceError('service.conflict', 'Native plugin graph was rejected'))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      record.ackWaiter = undefined
      reject(serviceError('service.unavailable', 'Native plugin acknowledgement timed out'))
    }, 5_000)
    record.ackWaiter = { event, reject, resolve, revision, timer }
  })
}

const sendPrivateLaunch = async (child, line) => {
  await new Promise((resolve, reject) => {
    let settled = false
    let timer
    let onClose
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClose)
      if (error != null) reject(error)
      else resolve()
    }
    onClose = () => finish(new Error('Native Runtime closed before private launch'))
    timer = setTimeout(() => finish(new Error('Native private launch timed out')), 2_000)
    child.once('close', onClose)
    child.stdin.write(line, finish)
  })
}

export const createNativeRuntimeAdapter = options => {
  if (typeof options?.stateDirectory !== 'string') {
    throw serviceError('service.invalid_request', 'Native Runtime state directory is required')
  }
  const records = new Map()
  const outputPool = new NativeOutputPool()
  const root = join(options.stateDirectory, 'native-processes')
  return createNativeLocalAdapter({
    closeInspector: async ({ inspector, process }) => {
      const record = records.get(process.id)
      if (record == null || record.generation !== process.generation) return
      record.inspectorLeases.get(inspector.id)?.close()
      record.inspectorLeases.delete(inspector.id)
    },
    openInspector: async ({ inspector, process, signal }) => {
      const record = requireRecord(records, process)
      if (record.closed || record.stopping || record.terminal != null || signal?.aborted) {
        throw serviceError('service.precondition_failed', 'Native Inspector generation is unavailable')
      }
      const connection = record.inspectorConnection
      if (connection == null) throw serviceError('service.precondition_failed', 'Native Inspector is disabled')
      await connection.connect()
      if (
        record.closed || record.stopping || record.terminal != null || signal?.aborted ||
        records.get(process.id) !== record
      ) {
        throw serviceError('service.precondition_failed', 'Native Inspector generation is stale')
      }
      const transport = connection.lease()
      record.inspectorLeases.set(inspector.id, transport)
      return { targetSession: process.generation, transport }
    },
    resumeProcess: async ({ process }) => {
      const record = requireRecord(records, process)
      if (record.closed || record.stopping || record.terminal != null || !record.waitingForDebugger) {
        throw serviceError('service.precondition_failed', 'Native Runtime is not waiting for a debugger')
      }
      if (!record.inspectorResumed) await record.inspectorConnection.resume()
    },
    applyRuntimePlugins: async ({ expectedRevision, process, revision, runtimePlugins }) => {
      const record = requireRecord(records, process)
      if (
        !record.pluginsEnabled || record.closed || record.stopping || record.terminal != null ||
        expectedRevision !== record.pluginRevision || revision !== expectedRevision + 1
      ) {
        throw serviceError('service.precondition_failed', 'Native plugin generation or revision is stale')
      }
      await record.initialReady
      if (record.closed || record.stopping || record.terminal != null) {
        throw serviceError('service.precondition_failed', 'Native Runtime ended before plugin update')
      }
      const key = JSON.stringify(runtimePlugins.map(bundle => [bundle.instanceId, bundle.bundleSha256]))
      if (key === record.pluginKey) {
        throw serviceError('service.conflict', 'Native plugin graph is unchanged')
      }
      if (record.pluginGraphCount >= MAX_NATIVE_PLUGIN_GENERATION_GRAPHS) {
        throw serviceError('service.limit_exceeded', 'Native plugin generation graph budget is exhausted')
      }
      const graph = await materializeNativePluginGraph(
        record.hostRoot,
        revision,
        runtimePlugins,
        MAX_NATIVE_PLUGIN_GENERATION_BYTES - record.pluginDiskBytes
      )
      try {
        const acknowledgement = waitForAck(record, 'update', revision)
        void acknowledgement.catch(() => undefined)
        await replaceNativePluginConfig(record.hostRoot, { ...record.hostConfig, plugins: graph.plugins })
        await acknowledgement
        if (record.closed || record.stopping || records.get(process.id) !== record) {
          throw serviceError('service.precondition_failed', 'Native Runtime ended during plugin update')
        }
        record.activePlugins = graph.plugins
        record.pluginKey = key
        record.pluginRevision = revision
        record.pluginDiskBytes += graph.bytes
        record.pluginGraphCount++
      } catch (error) {
        record.rejectAck?.(error)
        await replaceNativePluginConfig(record.hostRoot, {
          ...record.hostConfig,
          plugins: record.activePlugins
        }).catch(() => undefined)
        if (error?.code === 'service.unavailable') {
          await stopRecord(record, { terminalOnClose: true })
        }
        await rm(graph.directory, { force: true, recursive: true }).catch(() => undefined)
        throw error
      }
    },
    close: async () => {
      await Promise.allSettled([...records.values()].map(stopRecord))
      for (const record of records.values()) outputPool.release(record)
      records.clear()
    },
    listDevices: async () => {
      await validateNativeExecutable(options.executablePath)
      return [{ id: 'native:local', kind: 'local', platform: 'native', serial: 'local', state: 'online' }]
    },
    readLogs: async ({ after, limit, process }) => {
      const record = requireRecord(records, process)
      return outputPool.page(record, after, limit)
    },
    reconcileProcess: async ({ process }) => ({
      // Read-only check of the exact child this owner launched; a reused PID
      // conservatively stays pending. Reconciliation never signals a PID.
      cleaned: await recoveredChildExited(root, process)
    }),
    removeProcess: async ({ process, finalized = false }) => {
      const record = records.get(process.id)
      if (record != null && record.generation !== process.generation) {
        throw serviceError('service.precondition_failed', 'Native Runtime generation is stale')
      }
      if (process.cleanupPending === true && record?.generation !== process.generation) {
        throw serviceError('service.conflict', 'Native Runtime cleanup is still pending')
      }
      if (record != null && record.generation === process.generation) {
        await stopRecord(record)
        if (records.get(process.id) !== record) {
          throw serviceError('service.precondition_failed', 'Native Runtime generation changed')
        }
        outputPool.release(record)
        records.delete(process.id)
      } else if (await recoveredChildExited(root, process)) {
        await releasePrivateInspector(await storedPrivateInspector(root, process))
      }
      await rm(
        finalized ? processRootPath(root, process) : join(processRootPath(root, process), `g${process.generation}`),
        { force: true, recursive: true }
      )
    },
    startProcess: async ({ capabilityRuntime, process, signal }) => {
      if (signal?.aborted) throw serviceError('service.precondition_failed', 'Native launch was cancelled')
      await validateNativeExecutable(options.executablePath)
      const previous = records.get(process.id)
      if (previous != null) {
        await stopRecord(previous)
        outputPool.release(previous)
      }
      const privateInspector = await createPrivateInspector(process)
      let launch
      try {
        launch = await materializeNativeLaunch(
          process,
          options.stateDirectory,
          capabilityRuntime,
          candidate => privateLaunchLine(process, candidate, privateInspector),
          options.deviceProvider
        )
        if (privateInspector != null) {
          await writeFile(
            join(launch.hostRoot, 'inspector-owner.json'),
            JSON.stringify({
              device: privateInspector.device,
              directory: privateInspector.directory,
              generation: process.generation,
              inode: privateInspector.inode,
              processId: process.id,
              schemaVersion: 1
            }),
            { flag: 'wx', mode: 0o600 }
          )
        }
      } catch (error) {
        if (launch != null) await rm(launch.generationRoot, { force: true, recursive: true })
        await releasePrivateInspector(privateInspector)
        throw error
      }
      let line
      try {
        line = privateLaunchLine(process, launch, privateInspector)
      } catch (error) {
        await rm(launch.generationRoot, { force: true, recursive: true })
        await releasePrivateInspector(privateInspector)
        throw error
      }
      let child
      try {
        child = (options.spawn ?? spawn)(options.executablePath, ['__runtime'], {
          cwd: launch.generationRoot,
          env: { PATH: '' },
          stdio: process.launch.command === 'run'
            ? ['pipe', 'pipe', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe']
        })
      } catch {
        await rm(launch.generationRoot, { force: true, recursive: true })
        await releasePrivateInspector(privateInspector)
        throw serviceError('service.unavailable', 'Native Runtime could not start')
      }
      const record = {
        activePlugins: launch.plugins,
        hostConfig: launch.hostConfig,
        hostRoot: launch.hostRoot,
        pluginKey: JSON.stringify(
          (process.runtimePlugins ?? []).map(bundle => [bundle.instanceId, bundle.bundleSha256])
        ),
        pluginRevision: process.pluginGraphRevision ?? 0,
        pluginDiskBytes: launch.pluginDiskBytes,
        pluginGraphCount: 1,
        pluginsEnabled: process.launch.command === 'run',
        outputPool,
        child,
        command: process.launch.command,
        closed: false,
        exited: new Promise(resolve => child.once('close', resolve)),
        generation: process.generation,
        inspectorCleanup: Promise.resolve(),
        inspectorConnection: privateInspector == null
          ? undefined
          : new NativeInspectorConnection(privateInspector.socketPath, {
            onResume: () => record.inspectorResumed = true
          }),
        inspectorLeases: new Map(),
        inspectorPrivate: privateInspector,
        inspectorResumed: false,
        listeners: new Set(),
        logs: [],
        nextSequence: 1,
        reporter: process.launch.reporter ?? 'tap',
        stopping: false,
        waitingForDebugger: process.inspectorMode === 'break',
        terminal: undefined,
        testBuffer: '',
        testCandidate: undefined
      }
      records.set(process.id, record)
      if (record.pluginsEnabled) installAcknowledgements(record)
      child.stdin.on('error', () => undefined)
      collect(record, child.stdout, 'stdout')
      collect(record, child.stderr, 'stderr')
      child.once('close', (code, termination) => {
        record.closed = true
        record.inspectorConnection?.close()
        record.inspectorCleanup = releasePrivateInspector(record.inspectorPrivate)
        void record.inspectorCleanup.catch(() => undefined)
        record.rejectAck?.(serviceError('service.unavailable', 'Native Runtime ended before plugin acknowledgement'))
        if (record.terminalOnClose) record.stopping = false
        publishTerminal(record, record.terminalOnClose ? 1 : code, termination)
        if (record.terminalOnClose) record.listeners.clear()
      })
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
          throw serviceError('service.unavailable', 'Native child identity is unavailable')
        }
        await writeFile(
          childIdentityPath(root, process),
          JSON.stringify({
            generation: process.generation,
            pid: child.pid,
            processId: process.id
          }),
          { flag: 'wx', mode: 0o600 }
        )
        const ready = record.pluginsEnabled
          ? waitForAck(record, 'ready', record.pluginRevision)
          : undefined
        record.initialReady = ready
        if (ready != null) void ready.catch(() => undefined)
        await sendPrivateLaunch(child, line)
        if (ready != null && process.runtimePlugins != null) await ready
      } catch {
        records.delete(process.id)
        outputPool.release(record)
        child.stdin.destroy()
        child.kill('SIGKILL')
        const reaped = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), 2_000)
          timer.unref()
          void record.exited.then(() => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        if (reaped) await rm(launch.generationRoot, { force: true, recursive: true })
        if (reaped) await record.inspectorCleanup
        throw serviceError('service.unavailable', 'Native Runtime could not start', {
          details: { cleanupPending: !reaped }
        })
      }
      if (signal?.aborted) {
        await stopRecord(record)
        throw serviceError('service.precondition_failed', 'Native launch was cancelled')
      }
      return { waitingForDebugger: record.waitingForDebugger }
    },
    stopProcess: async ({ process }) => {
      const record = records.get(process.id)
      if (record != null && record.generation === process.generation) await stopRecord(record)
    },
    subscribeProcess: ({ onTerminal, process }) => {
      const record = requireRecord(records, process)
      record.listeners.add(onTerminal)
      if (record.terminal != null) queueMicrotask(() => onTerminal(record.terminal))
      return () => record.listeners.delete(onTerminal)
    }
  })
}
