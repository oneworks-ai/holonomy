import { serviceError } from './errors.mjs'
import { sendBytes, sendJson, sseHeaders } from './http-utils.mjs'
import { publicOperationDto, publicProcessDto } from './public-process-dto.mjs'
import { matchPath, numberQuery } from './router-parameters.mjs'
import { createServiceSkillManifest } from './skill-publisher.mjs'
import { requireInteger } from './validation.mjs'

const writeSseEvent = (response, event) =>
  response.write(
    `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  )

export const serveEvents = async (request, response, core, url, processId) => {
  const headerCursor = request.headers['last-event-id']
  const after = url.searchParams.has('after')
    ? numberQuery(url, 'after', 0, { min: 0 })
    : headerCursor == null
    ? undefined
    : requireInteger(Number(headerCursor), 'Last-Event-ID', { min: 0 })
  const buffered = []
  let replaying = true
  let closed = false
  const includesEvent = event => processId == null || event.subject === processId || event.data?.processId === processId
  const unsubscribe = core.subscribeEvents(event => {
    if (!includesEvent(event)) return
    if (replaying) buffered.push(event)
    else if (!writeSseEvent(response, event)) response.end()
  })
  request.once('close', () => {
    closed = true
    unsubscribe()
  })
  let replay
  try {
    replay = await core.readEvents(after)
  } catch (error) {
    unsubscribe()
    throw error
  }
  response.writeHead(200, {
    ...sseHeaders,
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8'
  })
  response.write('retry: 1000\n\n')
  let cursor = after ?? 0
  for (const event of replay) {
    if (event.cursor > cursor && includesEvent(event)) {
      cursor = event.cursor
      if (!writeSseEvent(response, event)) break
    }
  }
  replaying = false
  for (const event of buffered) {
    if (event.cursor > cursor && !closed && includesEvent(event)) {
      cursor = event.cursor
      if (!writeSseEvent(response, event)) break
    }
  }
}

export const routeGet = async (request, response, core, skillResources, url) => {
  if (url.pathname.startsWith('/.oo/skills/')) {
    const resource = await skillResources.read(url.pathname)
    return sendBytes(response, 200, resource.body, resource.contentType)
  }
  if (url.pathname === '/v1/service') return sendJson(response, 200, core.serviceStatus())
  if (url.pathname === '/v1/skills') return sendJson(response, 200, createServiceSkillManifest())
  if (url.pathname === '/v1/devices') return sendJson(response, 200, core.list('devices'))
  if (url.pathname === '/v1/emulators') return sendJson(response, 200, await core.listEmulators())
  if (url.pathname === '/v1/inspectors') return sendJson(response, 200, core.list('inspectors'))
  if (url.pathname === '/v1/network-rules') return sendJson(response, 200, core.list('networkRules'))
  if (url.pathname === '/v1/operations') {
    return sendJson(response, 200, core.list('operations').map(publicOperationDto))
  }
  if (url.pathname === '/v1/processes') {
    return sendJson(response, 200, core.list('processes').map(publicProcessDto))
  }
  if (url.pathname === '/v1/events/page') {
    return sendJson(response, 200, await core.readEvents(numberQuery(url, 'after', 0, { min: 0 })))
  }
  let match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/events$/u)
  if (match != null) return await serveEvents(request, response, core, url, match[0])
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/inspector-leases$/u)
  if (match != null) {
    core.get('processes', match[0], 'Runtime process')
    return sendJson(response, 200, core.list('inspectors').filter(value => value.processId === match[0]))
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/inspector-leases\/([^/]+)$/u)
  if (match != null) {
    const inspector = core.get('inspectors', match[1], 'Inspector lease')
    if (inspector.processId !== match[0]) throw serviceError('service.not_found', 'Inspector lease was not found')
    return sendJson(response, 200, inspector)
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/network\/rules$/u)
  if (match != null) {
    core.get('processes', match[0], 'Runtime process')
    return sendJson(response, 200, core.list('networkRules').filter(value => value.processId === match[0]))
  }
  match = matchPath(url.pathname, /^\/v1\/devices\/([^/]+)$/u)
  if (match != null) return sendJson(response, 200, core.get('devices', match[0], 'Device'))
  match = matchPath(url.pathname, /^\/v1\/operations\/([^/]+)$/u)
  if (match != null) {
    return sendJson(response, 200, publicOperationDto(core.get('operations', match[0], 'Operation')))
  }
  match = matchPath(url.pathname, /^\/v1\/inspectors\/([^/]+)$/u)
  if (match != null) return sendJson(response, 200, core.get('inspectors', match[0], 'Inspector lease'))
  match = matchPath(url.pathname, /^\/v1\/network-rules\/([^/]+)$/u)
  if (match != null) return sendJson(response, 200, core.get('networkRules', match[0], 'Network rules'))
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)\/logs$/u)
  if (match != null) {
    const logs = await core.readLogs(match[0], {
      after: numberQuery(url, 'after', 0, { min: 0 }),
      limit: numberQuery(url, 'limit', 128, { max: 1_024, min: 1 }),
      waitMs: numberQuery(url, 'waitMs', 0, { max: 30_000, min: 0 })
    })
    return sendJson(response, 200, logs)
  }
  match = matchPath(url.pathname, /^\/v1\/processes\/([^/]+)$/u)
  if (match != null) {
    return sendJson(response, 200, publicProcessDto(core.get('processes', match[0], 'Runtime process')))
  }
  throw serviceError('service.not_found', 'OpenAPI operation was not found')
}
