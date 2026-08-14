/* eslint-disable max-lines -- exact HTTP mutation ordering and shared error translation stay co-located. */

import { PROCESS_START_MAX_REQUEST_BYTES } from './constants.mjs'
import { serviceError } from './errors.mjs'
import { admitHttpRequest, admitRequestHost, readJsonRequest, sendJson, sendServiceError } from './http-utils.mjs'
import { HOLONOMY_SERVICE_OPENAPI } from './openapi.mjs'
import { publicProcessAdmissionDto, publicProcessRemovalDto } from './public-process-dto.mjs'
import { validateServiceRequest } from './request-schemas.mjs'
import { matchPath } from './router-parameters.mjs'
import { routeGet, serveEvents } from './router-read.mjs'
import { requireIdempotencyKey, requireInteger, requireRecord, requireString } from './validation.mjs'

const mutationKey = request => requireIdempotencyKey(request.headers['idempotency-key'])

const routeMutation = async (request, response, core, control, mutations, url, maxRequestBytes) => {
  if (request.method === 'POST' && url.pathname === '/v1/service:shutdown') {
    const body = validateServiceRequest('ServiceShutdownRequest', await readJsonRequest(request, maxRequestBytes))
    const key = mutationKey(request)
    return sendJson(
      response,
      202,
      await mutations.execute('service.shutdown', key, body, () => (
        control.shutdown(body, key)
      ))
    )
  }
  if (request.method === 'POST' && url.pathname === '/v1/service/token:rotate') {
    validateServiceRequest('ServiceTokenRotateRequest', await readJsonRequest(request, maxRequestBytes))
    const key = mutationKey(request)
    return sendJson(
      response,
      200,
      await mutations.execute('service.token.rotate', key, {}, () => (
        control.rotateToken(key)
      ))
    )
  }
  if (request.method === 'POST' && url.pathname === '/v1/devices:refresh') {
    return sendJson(response, 200, await core.refreshDevices())
  }
  let match = matchPath(url.pathname, /^\/v1\/emulators\/([^/]+):(restart|start|stop)$/u)
  if (request.method === 'POST' && match != null) {
    const idempotencyKey = mutationKey(request)
    const body = validateServiceRequest('EmulatorStartRequest', await readJsonRequest(request, maxRequestBytes))
    const result = match[1] === 'start'
      ? await core.startEmulator(match[0], body, idempotencyKey)
      : match[1] === 'restart'
      ? await core.restartEmulator(match[0], body, idempotencyKey)
      : await core.stopEmulator(match[0], idempotencyKey)
    return sendJson(response, 200, result)
  }
  if (request.method === 'POST' && url.pathname === '/v1/processes') {
    const body = validateServiceRequest(
      'ProcessStartRequest',
      await readJsonRequest(request, PROCESS_START_MAX_REQUEST_BYTES)
    )
    const admitted = await core.startProcess(body, mutationKey(request))
    return sendJson(response, admitted.replayed ? 200 : 202, publicProcessAdmissionDto(admitted))
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+):(restart|resume|stop)$/u)
  if (request.method === 'POST' && match != null) {
    const body = validateServiceRequest(
      'ExpectedGenerationRequest',
      await readJsonRequest(request, maxRequestBytes)
    )
    const expected = requireInteger(body.expectedGeneration, 'expectedGeneration', { min: 1 })
    const admitted = match[1] === 'stop'
      ? await core.stopProcess(match[0], expected, mutationKey(request))
      : match[1] === 'restart'
      ? await core.restartProcess(match[0], expected, mutationKey(request))
      : await core.resumeProcess(match[0], expected, mutationKey(request))
    return sendJson(response, admitted.replayed ? 200 : 202, publicProcessAdmissionDto(admitted))
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/(?:inspector-leases|inspectors)$/u)
  if (request.method === 'POST' && match != null) {
    const body = validateServiceRequest('InspectorOpenRequest', await readJsonRequest(request, maxRequestBytes))
    const expected = requireInteger(body.expectedGeneration, 'expectedGeneration', { min: 1 })
    const admitted = await core.openInspector(match[0], expected, body, mutationKey(request))
    return sendJson(response, admitted.replayed ? 200 : 202, admitted)
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/inspector-leases\/([^/]+)$/u)
  if (request.method === 'DELETE' && match != null) {
    const body = validateServiceRequest(
      'ExpectedGenerationRequest',
      await readJsonRequest(request, maxRequestBytes)
    )
    const key = mutationKey(request)
    return sendJson(response, 200, await core.closeProcessInspector(match[0], match[1], body.expectedGeneration, key))
  }
  match = matchPath(url.pathname, /^\/v1\/inspectors\/([^/]+):close$/u)
  if (request.method === 'POST' && match != null) {
    const body = validateServiceRequest(
      'ExpectedGenerationRequest',
      await readJsonRequest(request, maxRequestBytes)
    )
    const expected = requireInteger(body.expectedGeneration, 'expectedGeneration', { min: 1 })
    const key = mutationKey(request)
    return sendJson(response, 200, await core.closeInspector(match[0], expected, key))
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/(?:network-rules|network\/rules)$/u)
  const pluginMatch = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/runtime-plugins$/u)
  if (request.method === 'PUT' && pluginMatch != null) {
    const body = validateServiceRequest(
      'RuntimePluginsReplaceRequest',
      await readJsonRequest(request, PROCESS_START_MAX_REQUEST_BYTES)
    )
    const expectedRevision = requireInteger(
      Number(requireString(request.headers['if-match'], 'If-Match', { max: 64 })),
      'If-Match',
      { min: 0 }
    )
    const admitted = await core.replaceRuntimePlugins(
      pluginMatch[0],
      body.expectedGeneration,
      body.runtimePlugins,
      expectedRevision,
      mutationKey(request)
    )
    return sendJson(response, admitted.replayed ? 200 : 202, publicProcessAdmissionDto(admitted))
  }
  if (request.method === 'PUT' && match != null) {
    const body = validateServiceRequest(
      'NetworkRulesReplaceRequest',
      requireRecord(await readJsonRequest(request, maxRequestBytes), 'Network rule request')
    )
    const expected = requireInteger(body.expectedGeneration, 'expectedGeneration', { min: 1 })
    const expectedRuleRevision = requireString(request.headers['if-match'], 'If-Match', { max: 64 })
    const admitted = await core.replaceNetworkRules(
      match[0],
      expected,
      { mode: body.mode, rules: body.rules },
      expectedRuleRevision,
      mutationKey(request)
    )
    return sendJson(response, admitted.replayed ? 200 : 202, admitted)
  }
  if (request.method === 'DELETE' && match != null && url.pathname.endsWith('/network/rules')) {
    const body = validateServiceRequest(
      'ExpectedGenerationRequest',
      await readJsonRequest(request, maxRequestBytes)
    )
    const expectedRuleRevision = requireString(request.headers['if-match'], 'If-Match', { max: 64 })
    const admitted = await core.removeProcessNetworkRules(
      match[0],
      body.expectedGeneration,
      expectedRuleRevision,
      mutationKey(request)
    )
    return sendJson(response, admitted.replayed ? 200 : 202, admitted)
  }
  match = matchPath(url.pathname, /^\/v1\/network-rules\/([^/]+)$/u)
  if (request.method === 'DELETE' && match != null) {
    const body = validateServiceRequest(
      'ExpectedGenerationRequest',
      await readJsonRequest(request, maxRequestBytes)
    )
    const expectedRuleRevision = requireString(request.headers['if-match'], 'If-Match', { max: 64 })
    const admitted = await core.removeNetworkRules(
      match[0],
      body.expectedGeneration,
      expectedRuleRevision,
      mutationKey(request)
    )
    return sendJson(response, admitted.replayed ? 200 : 202, admitted)
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)$/u)
  if (request.method === 'DELETE' && match != null) {
    const body = validateServiceRequest(
      'ExpectedGenerationRequest',
      await readJsonRequest(request, maxRequestBytes)
    )
    const key = mutationKey(request)
    return sendJson(
      response,
      200,
      publicProcessRemovalDto(await core.removeProcess(match[0], body.expectedGeneration, key))
    )
  }
  throw serviceError('service.not_found', 'OpenAPI operation was not found')
}

export const createServiceRequestHandler = options => async (request, response) => {
  try {
    const host = request.headers.host ?? '127.0.0.1'
    admitRequestHost(request, options.allowedHosts)
    const url = new URL(request.url ?? '/', `${options.secure ? 'https' : 'http'}://${host}`)
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return sendJson(response, 200, { apiVersion: '1.0.0', status: 'ready' })
    }
    if (url.pathname === '/openapi.json' && request.method === 'GET') {
      return sendJson(response, 200, HOLONOMY_SERVICE_OPENAPI)
    }
    admitHttpRequest(request, options.token, options.allowedHosts)
    if (url.pathname === '/v1/events' && request.method === 'GET') {
      return await serveEvents(request, response, options.core, url)
    }
    if (request.method === 'GET') {
      return await routeGet(request, response, options.core, options.skillResources, url)
    }
    return await routeMutation(
      request,
      response,
      options.core,
      options.control,
      options.mutationCoordinator,
      url,
      options.maxRequestBytes
    )
  } catch (error) {
    sendServiceError(response, error)
  }
}
