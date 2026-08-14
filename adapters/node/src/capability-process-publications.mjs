import { nodeError } from './capability-process-support.mjs'

export const closeProcessStdinV1 = (state, destroy = false) => {
  if (state.stdinClosed) return
  state.stdinClosed = true
  state.stdinEnded = true
  const error = state.stdinError ?? nodeError('ERR_INVALID_STATE')
  for (const callbackId of [...state.pendingStdinCallbacks]) {
    state.pendingStdinCallbacks.delete(callbackId)
    state.stdinEvents.emit({ callbackId, error, event: 'callback' })
  }
  state.stdinEvents.close()
  if (destroy && state.child.stdin?.destroyed !== true) state.child.stdin?.destroy()
}

export const processResourcePublicationsV1 = (state, closeState) => {
  const { child, childEvents, facade, resource, stderrEvents, stdinEvents, stdoutEvents } = state
  const publication = (bindingId, type, events, close, eventSchemaId) => ({
    bindingId,
    close,
    eventSchemaId,
    resource,
    resourceType: type,
    subscribe: listener => events.subscribe(listener)
  })
  return [
    publication(
      facade.binding.bindingId,
      'process.child',
      childEvents,
      closeState,
      'ChildProcessEventV1'
    ),
    ...(facade.stdin == null ? [] : [publication(
      facade.stdin.binding.bindingId,
      'process.stdin',
      stdinEvents,
      () => closeProcessStdinV1(state, true),
      'ChildProcessStdinEventV1'
    )]),
    ...(facade.stdout == null ? [] : [publication(
      facade.stdout.binding.bindingId,
      'process.readable',
      stdoutEvents,
      () => child.stdout?.destroy(),
      'ChildProcessReadableEventV1'
    )]),
    ...(facade.stderr == null ? [] : [publication(
      facade.stderr.binding.bindingId,
      'process.readable',
      stderrEvents,
      () => child.stderr?.destroy(),
      'ChildProcessReadableEventV1'
    )])
  ]
}
