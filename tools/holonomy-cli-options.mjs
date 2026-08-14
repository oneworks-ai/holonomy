import process from 'node:process'

const defaultRootUrl = 'app+local://workspace/'

const readPort = argument => {
  const value = argument.includes('=') ? Number(argument.slice(argument.indexOf('=') + 1)) : 9229
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) throw new Error('Inspector port must be 1..65535')
  return value
}

export const parseHolonomyArgs = input => {
  const arguments_ = [...input]
  const command = arguments_.shift()
  if (command !== 'run' && command !== 'test') throw new Error('Usage: holonomy <run|test> [options] <files>')
  const options = {
    allowFailures: false,
    argv: [],
    capabilityRuntime: undefined,
    config: undefined,
    detach: false,
    entries: [],
    env: {},
    inspect: undefined,
    isolation: 'runtime',
    networkRules: undefined,
    openapi: 'auto',
    openapiTokenFile: undefined,
    openDevTools: false,
    pluginRoots: [],
    reporter: 'tap',
    rootUrl: defaultRootUrl,
    sandbox: undefined,
    target: undefined,
    timeoutMs: 120_000,
    timeoutExplicit: false,
    watch: false
  }
  while (arguments_.length > 0) {
    const argument = arguments_.shift()
    if (argument === '--target') options.target = arguments_.shift()
    else if (argument === '--device' || argument === '--serial') options.serial = arguments_.shift()
    else if (argument === '--capability-runtime') options.capabilityRuntime = arguments_.shift()
    else if (argument === '--config') options.config = arguments_.shift()
    else if (argument === '--root-url') options.rootUrl = arguments_.shift()
    else if (argument === '--reporter') options.reporter = arguments_.shift()
    else if (argument === '--env') {
      const item = arguments_.shift() ?? ''
      const separator = item.indexOf('=')
      if (separator <= 0) throw new Error('--env requires KEY=VALUE')
      options.env[item.slice(0, separator)] = item.slice(separator + 1)
    } else if (argument === '--arg') options.argv.push(arguments_.shift() ?? '')
    else if (argument === '--allow-failures') options.allowFailures = true
    else if (argument === '--detach') options.detach = true
    else if (argument === '--openapi') options.openapi = arguments_.shift()
    else if (argument === '--openapi-token-file') options.openapiTokenFile = arguments_.shift()
    else if (argument === '--isolation') options.isolation = arguments_.shift()
    else if (argument === '--network-rules') options.networkRules = arguments_.shift()
    else if (argument === '--sandbox') {
      options.sandbox = arguments_.shift()
      if (options.sandbox == null || options.sandbox === '') throw new Error('--sandbox requires one JSON file')
    } else if (argument === '--devtools') options.openDevTools = true
    else if (argument === '--plugin-root') options.pluginRoots.push(arguments_.shift() ?? '')
    else if (argument === '--watch') options.watch = true
    else if (argument === '--timeout') {
      options.timeoutMs = Number(arguments_.shift())
      options.timeoutExplicit = true
    } else if (argument === '--inspect' || argument?.startsWith('--inspect=')) {
      options.inspect = { breakBeforeEntry: false, port: readPort(argument) }
    } else if (argument === '--inspect-brk' || argument?.startsWith('--inspect-brk=')) {
      options.inspect = { breakBeforeEntry: true, port: readPort(argument) }
    } else if (argument?.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
    else options.entries.push(argument)
  }
  if (options.target !== 'android' && options.target !== 'node') {
    throw new Error('--target android|node is required')
  }
  if (options.isolation !== 'runtime' && options.isolation !== 'isolatedProcess') {
    throw new Error('--isolation must be runtime or isolatedProcess')
  }
  if (options.target === 'node' && options.isolation !== 'runtime') {
    throw new Error('--isolation isolatedProcess is supported only by Android')
  }
  if (options.config === '') throw new Error('--config requires one JSON file')
  if (options.capabilityRuntime === '') throw new Error('--capability-runtime requires one JSON file')
  if (options.pluginRoots.includes('')) throw new Error('--plugin-root requires one directory')
  if (command !== 'run' && (options.config != null || options.watch || options.pluginRoots.length > 0)) {
    throw new Error('Runtime plugins are supported only by holonomy run')
  }
  if (options.watch && options.detach) throw new Error('--watch cannot be combined with --detach')
  if (options.watch && options.target !== 'node') throw new Error('--watch is supported by Node/Desktop Runtime only')
  if (options.watch && options.config == null) options.config = 'holo.config.json'
  if (typeof options.openapi !== 'string' || options.openapi === '') throw new Error('--openapi requires auto or a URL')
  if (options.openapi !== 'auto') {
    try {
      const endpoint = new URL(options.openapi)
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw new Error('--openapi must be auto or an absolute HTTP(S) URL')
    }
  }
  if (options.openapiTokenFile != null && options.openapi === 'auto') {
    throw new Error('--openapi-token-file is only valid with an explicit --openapi URL')
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid --timeout value')
  if (options.watch && !options.timeoutExplicit) options.timeoutMs = Number.MAX_SAFE_INTEGER
  if (options.reporter !== 'tap' && options.reporter !== 'json') throw new Error('Reporter must be tap or json')
  if (options.entries.length === 0) {
    if (command === 'run') throw new Error('holonomy run requires an entry module')
    options.entries = ['conformance/specs/**/*.test.mjs']
  }
  return { command, options }
}

export const failHolonomyCommand = message => {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
