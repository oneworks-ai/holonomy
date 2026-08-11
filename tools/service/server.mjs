import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isAbsolute, join } from 'node:path'

import { handleInspectorUpgrade } from './cdp-websocket-server.mjs'
import { HolonomyControlCore } from './control-core.mjs'
import { serviceError } from './errors.mjs'
import { admitRequestHost, validateHttpConfiguration } from './http-utils.mjs'
import { DurableMutationCoordinator } from './mutation-coordinator.mjs'
import { createNodeRuntimeAdapter } from './node-target-adapter.mjs'
import { createOptionalAndroidRuntimeAdapter } from './optional-android-target-adapter.mjs'
import { createServiceRequestHandler } from './router.mjs'
import { ServiceLogStore } from './service-log-store.mjs'
import { ServiceSkillResources } from './skill-resources.mjs'
import { AtomicServiceStateStore } from './state-store.mjs'
import { createTargetAdapterDispatcher } from './target-adapters.mjs'
import { requireString } from './validation.mjs'

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })

const closeServer = server =>
  new Promise(resolve => {
    server.close(() => resolve())
    server.closeIdleConnections?.()
  })

export const createHolonomyService = options => {
  const configuration = validateHttpConfiguration(options)
  if (options.store == null) {
    requireString(options.stateDirectory, 'Service state directory')
    if (!isAbsolute(options.stateDirectory)) {
      throw serviceError('service.invalid_request', 'Service state directory must be absolute')
    }
  }
  const store = options.store ?? new AtomicServiceStateStore({
    directory: options.stateDirectory,
    journalDirectory: options.journalDirectory,
    maxEventBytes: options.maxEventBytes,
    maxEventsPerRead: options.maxEventsPerRead,
    maxStateBytes: options.maxStateBytes,
    now: options.now,
    retentionMs: options.retentionMs
  })
  const adapterDispatcher = options.adapterDispatcher ?? createTargetAdapterDispatcher({
    android: options.adbPort ?? createOptionalAndroidRuntimeAdapter({
      emulatorStateFile: options.stateDirectory == null ? undefined : join(options.stateDirectory, 'emulators.json'),
      leaseStateFile: options.stateDirectory == null ? undefined : join(options.stateDirectory, 'adb-leases.json')
    }),
    node: options.nodeAdapter ?? createNodeRuntimeAdapter()
  })
  const mutationCoordinator = options.mutationCoordinator ?? new DurableMutationCoordinator({
    file: options.stateDirectory == null ? undefined : join(options.stateDirectory, 'mutations.json'),
    now: options.now
  })
  const logStore = options.logStore ?? new ServiceLogStore({
    directory: join(options.stateDirectory, 'logs'),
    now: options.now,
    ttlMs: options.retentionMs
  })
  const core = options.core ?? new HolonomyControlCore({
    adapterDispatcher,
    fixtureManager: options.fixtureManager,
    inspectorProxy: options.inspectorProxy,
    logStore,
    mutationCoordinator,
    now: options.now,
    retentionMs: options.retentionMs,
    store
  })
  let activeToken = configuration.token
  const handler = createServiceRequestHandler({
    allowedHosts: configuration.allowedHosts,
    control: options.control ?? {
      rotateToken: async () => {
        throw serviceError('service.unsupported', 'Token rotation is not managed by this service instance')
      },
      shutdown: async () => {
        throw serviceError('service.unsupported', 'Shutdown is not managed by this service instance')
      }
    },
    core,
    inspectorProxy: core.inspectorProxy(),
    maxRequestBytes: configuration.maxRequestBytes,
    mutationCoordinator,
    secure: configuration.tls != null,
    skillResources: options.skillResources ?? new ServiceSkillResources({ directory: options.skillDirectory }),
    token: () => activeToken
  })
  const server = configuration.tls == null
    ? createHttpServer(handler)
    : createHttpsServer(configuration.tls, handler)
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.requestTimeout = 30_000
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    try {
      admitRequestHost(request, configuration.allowedHosts)
      handleInspectorUpgrade(core.inspectorProxy(), request, socket, head)
    } catch {
      socket.end('HTTP/1.1 400 Rejected\r\nConnection: close\r\n\r\n')
    }
  })
  let started = false
  let closed = false
  let pruneTimer
  let endpoint

  return Object.freeze({
    get baseUrl() {
      if (!started || endpoint == null) throw serviceError('service.unavailable', 'Holonomy Service is not listening')
      return endpoint
    },
    core,
    inspectorProxy: core.inspectorProxy(),
    rotateToken(token) {
      activeToken = requireString(token, 'Service token', { max: 4_096, min: 32 })
    },
    async close() {
      if (closed) return
      closed = true
      if (pruneTimer != null) clearInterval(pruneTimer)
      for (const socket of sockets) socket.destroy()
      if (started) await closeServer(server)
      await core.close()
    },
    server,
    async start() {
      if (closed) throw serviceError('service.unavailable', 'Holonomy Service is closed')
      if (started) return endpoint
      await core.open()
      await listen(server, configuration.port, configuration.host)
      const address = server.address()
      if (address == null || typeof address === 'string') {
        await closeServer(server)
        throw serviceError('service.internal', 'Holonomy Service address is invalid')
      }
      const renderedHost = configuration.advertiseHost.includes(':')
        ? `[${configuration.advertiseHost}]`
        : configuration.advertiseHost
      endpoint = `${configuration.tls == null ? 'http' : 'https'}://${renderedHost}:${address.port}`
      core.inspectorProxy().configureEndpoint(endpoint)
      started = true
      pruneTimer = setInterval(() => void core.pruneRetention().catch(() => undefined), 60 * 60 * 1_000)
      pruneTimer.unref()
      return endpoint
    },
    store
  })
}
