import { invalidPolicy } from './errors.js'
import type { ProcessLimitsV2, ProcessSandboxV2 } from './policy-process-types.js'
import type { FilesystemSandboxV2 } from './policy-types.js'
import { array, exact, identifier, integer, literal, required, string, stringSet } from './validation.js'

const limits = (value: unknown): ProcessLimitsV2 => {
  const input = exact(value, [
    'maxConcurrentProcesses',
    'maxExecutionTimeMs',
    'maxOpenPipes',
    'maxProcessTreeDepth',
    'maxStderrBytes',
    'maxStdinBytes',
    'maxStdoutBytes',
    'maxTotalProcesses',
    'maxWritableRootfsBytes'
  ])
  const output = Object.freeze({
    maxConcurrentProcesses: integer(required(input, 'maxConcurrentProcesses'), 1, 64),
    maxExecutionTimeMs: integer(required(input, 'maxExecutionTimeMs'), 1, 86_400_000),
    maxOpenPipes: integer(required(input, 'maxOpenPipes'), 0, 256),
    maxProcessTreeDepth: integer(required(input, 'maxProcessTreeDepth'), 1, 32),
    maxStderrBytes: integer(required(input, 'maxStderrBytes'), 1, 16 * 1024 * 1024),
    maxStdinBytes: integer(required(input, 'maxStdinBytes'), 1, 16 * 1024 * 1024),
    maxStdoutBytes: integer(required(input, 'maxStdoutBytes'), 1, 16 * 1024 * 1024),
    maxTotalProcesses: integer(required(input, 'maxTotalProcesses'), 1, 100_000),
    maxWritableRootfsBytes: integer(required(input, 'maxWritableRootfsBytes'), 0, 4 * 1024 * 1024 * 1024)
  })
  if (output.maxConcurrentProcesses > output.maxTotalProcesses) return invalidPolicy()
  return output
}

const guestPath = (value: unknown): string => {
  const input = string(value, 4096)
  if (!input.startsWith('/') || input !== '/' && input.endsWith('/') || /[\\\0]/u.test(input)) {
    return invalidPolicy()
  }
  const segments = input === '/' ? [] : input.slice(1).split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return invalidPolicy()
  }
  return input
}

export const normalizeProcessSandbox = (
  value: unknown,
  filesystem: FilesystemSandboxV2
): ProcessSandboxV2 => {
  const input = exact(value, [
    'access',
    'environment',
    'executables',
    'limits',
    'mounts',
    'network',
    'shell'
  ])
  const access = literal(required(input, 'access'), ['none', 'sandboxed'] as const)
  if (access === 'none') {
    if (Object.keys(input).length !== 1) return invalidPolicy()
    return Object.freeze({ access })
  }
  const executableIds = new Set<string>()
  const executables = array(required(input, 'executables'), 1, 256).map(value => {
    const executable = exact(value, ['argumentBytes', 'executableId'])
    const executableId = identifier(required(executable, 'executableId'))
    if (executableIds.has(executableId)) return invalidPolicy()
    executableIds.add(executableId)
    return Object.freeze({
      argumentBytes: integer(required(executable, 'argumentBytes'), 1, 16 * 1024 * 1024),
      executableId
    })
  }).sort((left, right) => left.executableId.localeCompare(right.executableId))
  const shellInput = exact(required(input, 'shell'), ['access', 'executableId'])
  const shellAccess = literal(required(shellInput, 'access'), ['none', 'restricted'] as const)
  const shell = shellAccess === 'none'
    ? (() => {
      if (Object.keys(shellInput).length !== 1) return invalidPolicy()
      return Object.freeze({ access: 'none' as const })
    })()
    : Object.freeze({
      access: 'restricted' as const,
      executableId: identifier(required(shellInput, 'executableId'))
    })
  if (shell.access === 'restricted' && !executableIds.has(shell.executableId)) return invalidPolicy()
  const roots = new Map(
    filesystem.access === 'sandboxed'
      ? filesystem.roots.map(root => [root.rootId, new Set(root.rights)] as const)
      : []
  )
  const mounts = array(required(input, 'mounts'), 0, 64).map(value => {
    const mount = exact(value, ['guestPath', 'rights', 'rootId'])
    const rootId = identifier(required(mount, 'rootId'), 64)
    const rights = stringSet(required(mount, 'rights'), ['read', 'write'] as const, 1, 2)
    const rootRights = roots.get(rootId)
    if (rootRights == null || rights.some(right => !rootRights.has(right))) return invalidPolicy()
    return Object.freeze({ guestPath: guestPath(required(mount, 'guestPath')), rights, rootId })
  }).sort((left, right) => left.guestPath.localeCompare(right.guestPath))
  if (new Set(mounts.map(mount => mount.guestPath)).size !== mounts.length) return invalidPolicy()
  const networkInput = exact(required(input, 'network'), ['access', 'endpoints', 'maxSockets'])
  const networkAccess = literal(required(networkInput, 'access'), ['none', 'restricted'] as const)
  const network = networkAccess === 'none'
    ? (() => {
      if (Object.keys(networkInput).length !== 1) return invalidPolicy()
      return Object.freeze({ access: 'none' as const })
    })()
    : Object.freeze({
      access: 'restricted' as const,
      endpoints: Object.freeze(
        array(required(networkInput, 'endpoints'), 0, 256).map(value => {
          const endpoint = exact(value, ['hostname', 'ports', 'transport'])
          const ports = array(required(endpoint, 'ports'), 1, 64)
            .map(port => integer(port, 1, 65_535)).sort((left, right) => left - right)
          if (new Set(ports).size !== ports.length) return invalidPolicy()
          return Object.freeze({
            hostname: string(required(endpoint, 'hostname'), 253).toLowerCase(),
            ports: Object.freeze(ports),
            transport: literal(required(endpoint, 'transport'), ['tcp', 'tls'] as const)
          })
        })
      ),
      maxSockets: integer(required(networkInput, 'maxSockets'), 1, 256)
    })
  const environmentInput = exact(required(input, 'environment'), ['allowedNames', 'maxValueBytes'])
  const allowedNames = array(required(environmentInput, 'allowedNames'), 0, 256).map(value => {
    const name = string(value, 128)
    if (!/^[A-Za-z_]\w*$/u.test(name)) return invalidPolicy()
    return name
  }).sort()
  if (new Set(allowedNames).size !== allowedNames.length) return invalidPolicy()
  return Object.freeze({
    access,
    environment: Object.freeze({
      allowedNames: Object.freeze(allowedNames),
      maxValueBytes: integer(required(environmentInput, 'maxValueBytes'), 1, 16 * 1024 * 1024)
    }),
    executables: Object.freeze(executables),
    limits: limits(required(input, 'limits')),
    mounts: Object.freeze(mounts),
    network,
    shell
  })
}
