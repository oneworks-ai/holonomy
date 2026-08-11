const commandTable = Object.freeze({
  device: new Set(['list', 'show']),
  emulator: new Set(['list', 'restart', 'start', 'stop']),
  process: new Set(['inspect', 'list', 'logs', 'remove', 'restart', 'show', 'stop']),
  service: new Set(['start', 'status', 'stop', 'token'])
})

const takesIdentifier = (group, command) => (
  (group === 'device' && command === 'show') ||
  (group === 'emulator' && ['restart', 'stop'].includes(command)) ||
  (group === 'process' && !['list'].includes(command))
)

const readPort = value => {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be 0..65535')
  return port
}

export const parseHolonomyManagementArgs = input => {
  const arguments_ = [...input]
  const group = arguments_.shift()
  if (!Object.hasOwn(commandTable, group)) return undefined
  const command = arguments_.shift()
  if (typeof command !== 'string' || !commandTable[group].has(command)) {
    throw new Error(`Unknown holonomy ${group} command`)
  }
  let action = command
  if (group === 'service' && command === 'token') {
    action = arguments_.shift()
    if (action !== 'rotate') throw new Error('Usage: holonomy service token rotate')
  }
  const options = {
    after: 0,
    detach: false,
    devtools: false,
    drain: false,
    follow: false,
    openapi: 'auto',
    wait: false
  }
  let id
  if (takesIdentifier(group, command)) {
    id = arguments_.shift()
    if (typeof id !== 'string' || id === '') throw new Error(`holonomy ${group} ${command} requires an id`)
  } else if (group === 'emulator' && command === 'start') {
    options.avd = arguments_.shift()
    if (typeof options.avd !== 'string' || options.avd === '') {
      throw new Error('holonomy emulator start requires an AVD name')
    }
  }
  while (arguments_.length > 0) {
    const argument = arguments_.shift()
    if (argument === '--after') options.after = Number(arguments_.shift())
    else if (argument === '--devtools') options.devtools = true
    else if (argument === '--device') options.deviceId = arguments_.shift()
    else if (argument === '--drain') options.drain = true
    else if (argument === '--follow') options.follow = true
    else if (argument === '--listen') options.listen = arguments_.shift()
    else if (argument === '--openapi') options.openapi = arguments_.shift()
    else if (argument === '--openapi-token-file') options.openapiTokenFile = arguments_.shift()
    else if (argument === '--port') options.port = readPort(arguments_.shift())
    else if (argument === '--tls-cert') options.tlsCert = arguments_.shift()
    else if (argument === '--tls-key') options.tlsKey = arguments_.shift()
    else if (argument === '--wait') options.wait = true
    else if (argument === '--expected-generation') options.expectedGeneration = Number(arguments_.shift())
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (!Number.isSafeInteger(options.after) || options.after < 0) {
    throw new Error('--after must be a non-negative integer')
  }
  if (
    options.expectedGeneration != null &&
    (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration <= 0)
  ) throw new Error('--expected-generation must be a positive integer')
  if ((options.tlsCert == null) !== (options.tlsKey == null)) {
    throw new Error('--tls-cert and --tls-key must be provided together')
  }
  if (options.openapi !== 'auto') {
    try {
      const url = new URL(options.openapi)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw new Error('--openapi must be auto or an absolute HTTP(S) URL')
    }
  }
  if (options.openapiTokenFile != null && options.openapi === 'auto') {
    throw new Error('--openapi-token-file is only valid with an explicit --openapi URL')
  }
  return Object.freeze({ action, command, group, id, options: Object.freeze(options) })
}
