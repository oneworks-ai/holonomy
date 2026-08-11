import { Buffer } from 'node:buffer'

import { serviceError } from './errors.mjs'
import { ingestNetworkOutput } from './network-output-ingest.mjs'
import { cloneJson, requireInteger } from './validation.mjs'

export const readProcessLogs = async (context, processId, options = {}) => {
  const process = context.registry.get('processes', processId, 'Runtime process')
  const after = requireInteger(options.after ?? 0, 'Log cursor', { min: 0 })
  const limit = requireInteger(options.limit ?? 128, 'Log limit', { max: 1_024, min: 1 })
  const waitMs = requireInteger(options.waitMs ?? 0, 'Log wait', { max: 30_000, min: 0 })
  const output = await context.adapters.target(process.target).readLogs({ after, limit, process, waitMs })
  if (output == null || !Array.isArray(output.events) || !Number.isSafeInteger(output.cursor)) {
    throw serviceError('service.unavailable', 'Adapter log response is invalid')
  }
  const copied = cloneJson(output)
  const bytes = Buffer.byteLength(JSON.stringify(copied), 'utf8')
  if (copied.events.length > limit || bytes > 1024 * 1024) {
    throw serviceError('service.limit_exceeded', 'Adapter log response exceeds its limit')
  }
  copied.events = ingestNetworkOutput(context.inspectorProxy, process, copied.events)
  return copied
}
