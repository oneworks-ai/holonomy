export default context => {
  context.holo.engineGate(request => {
    if (request.operation !== 'runtime.code.generate.strings') {
      return { action: 'deny', reasonCode: 'host.unapproved_operation' }
    }
    return { action: 'allow' }
  })
}
