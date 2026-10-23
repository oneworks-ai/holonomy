import { cdpError, processKey } from './cdp-session-support.mjs'
import { gateInspectorCdpCommandV1 } from './inspector-engine-gate.mjs'
import { requireIdentifier, requireRecord } from './validation.mjs'

export const receiveInspectorCdpMessageV1 = async ({
  bodyCache,
  engineGate,
  input,
  isCurrent,
  resumes,
  session,
  sourceReaderHostCaps
}) => {
  const message = requireRecord(input, 'CDP message')
  if (!Number.isSafeInteger(message.id) || typeof message.method !== 'string') return cdpError(message.id)
  if (!isCurrent()) return cdpError(message.id)
  try {
    if (message.method === 'Network.enable') {
      session.enabled = true
      return { id: message.id, result: {} }
    }
    if (message.method === 'Network.disable') {
      session.enabled = false
      return { id: message.id, result: {} }
    }
    if (message.method === 'Network.getResponseBody') {
      const requestId = requireIdentifier(message.params?.requestId, 'Request id')
      return {
        id: message.id,
        result: bodyCache.get(processKey(session.lease.processId, session.lease.generation), requestId)
      }
    }
    if (message.method.startsWith('Network.')) return cdpError(message.id)
    // Native resume is a Service lifecycle operation before any upstream I/O.
    // Its owner survives a disconnected client; the adapter uses its own lease.
    const nativeResume = await resumes.beforeNativeDispatch(session.lease, message)
    if (nativeResume != null) return isCurrent() ? nativeResume : cdpError(message.id)
    if (
      !session.lease.nativeUpstreamGate &&
      !await gateInspectorCdpCommandV1({
        context: session.lease.engineGateContext,
        engineGate,
        isCurrent,
        message,
        sourceReaderHostCaps
      })
    ) return cdpError(message.id)
    const response = await session.lease.transport.send(message)
    if (!isCurrent()) return cdpError(message.id)
    return await resumes.afterResponse(session.lease, message, response)
  } catch {
    return cdpError(message.id)
  }
}
