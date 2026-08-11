import { spawn } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { serviceError } from './errors.mjs'
import { HolonomyServiceClient } from './service-client.mjs'
import { prepareServiceHome, resolveHolonomyHome } from './service-home.mjs'

const ENTRY = fileURLToPath(new URL('./entry.mjs', import.meta.url))

export const ensureHolonomyServiceProcess = async (options = {}) => {
  const environment = options.environment ?? process.env
  const remote = options.baseUrl ?? options.openapiUrl ?? environment.HOLONOMY_OPENAPI_URL ??
    environment.HOLONOMY_SERVICE_URL
  const home = options.home ?? resolveHolonomyHome(environment)
  const client = options.client ?? new HolonomyServiceClient({
    baseUrl: options.baseUrl,
    environment,
    home,
    openapiUrl: options.openapiUrl,
    token: options.token,
    tokenFile: options.tokenFile
  })
  const current = await client.status()
  if (current.running) return { ...current, reused: true }
  if (remote != null) {
    throw serviceError('service.unavailable', 'Remote Holonomy Service is unavailable')
  }
  await prepareServiceHome(home)
  const childEnvironment = {
    ...environment,
    HOLONOMY_HOME: home,
    ...(options.host == null ? {} : { HOLONOMY_SERVICE_HOST: options.host }),
    ...(options.port == null ? {} : { HOLONOMY_SERVICE_PORT: String(options.port) }),
    ...(options.tlsCert == null ? {} : { HOLONOMY_SERVICE_TLS_CERT: options.tlsCert }),
    ...(options.tlsKey == null ? {} : { HOLONOMY_SERVICE_TLS_KEY: options.tlsKey })
  }
  const child = (options.spawn ?? spawn)(process.execPath, [ENTRY], {
    detached: true,
    env: childEnvironment,
    stdio: 'ignore'
  })
  child.unref()
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  while (Date.now() < deadline) {
    const status = await client.status()
    if (status.running) return { ...status, reused: false }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw serviceError('service.unavailable', 'Holonomy Service process did not become ready')
}
