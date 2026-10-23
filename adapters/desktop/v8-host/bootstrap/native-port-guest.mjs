import { RuntimeBuffer } from '../../../../packages/runtime/src/node-compat/buffer.ts'

export const createNativeGuestPort = host => {
  const stringify = JSON.stringify
  const parse = JSON.parse
  const Bytes = Uint8Array
  const decode = json => {
    const event = parse(json)
    if (event.binary) {
      event.binary = event.binary.map(item => ({
        handle: item.handle,
        data: new Bytes(RuntimeBuffer.from(item.base64, 'base64'))
      }))
    }
    return event
  }
  return {
    dispatch(request, context, sink, resourceSink) {
      const value = {
        ...request,
        ...(request.binary == null
          ? {}
          : {
            binary: request.binary.map(item => ({
              handle: item.handle,
              base64: RuntimeBuffer.from(item.data).toString('base64')
            }))
          })
      }
      host.portDispatch(
        stringify(value),
        stringify(context),
        event => sink(decode(event)),
        event => resourceSink(decode(event))
      )
    },
    cancel: callToken => host.portCommand(stringify({ kind: 'cancel', callToken })),
    closeResource: (ownerCallToken, providerToken) =>
      host.portCommand(stringify({ kind: 'close', ownerCallToken, providerToken })),
    grantCredits: (callToken, credits) => host.portCommand(stringify({ kind: 'credits', callToken, credits })),
    dispose: () => host.portCommand(stringify({ kind: 'dispose' }))
  }
}
