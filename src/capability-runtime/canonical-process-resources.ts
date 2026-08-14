import { canonicalDigest } from './canonical-json.js'
import type {
  InvocationBindingInputV1,
  InvocationResourceBindingV1,
  ProcessExecutableResourceV1,
  ProcessInstanceResourceV1,
  ProcessNetworkEndpointResourceV1
} from './resource-types.js'
import { digest, resourceDisplay } from './resource-validation.js'
import { identifier, integer, literal, string } from './validation.js'

interface ProcessCommonInput {
  readonly cwdSemanticResourceDigest?: unknown
  readonly environmentNamesDigest: unknown
  readonly environmentScope: unknown
  readonly label: unknown
  readonly stdioDigest: unknown
}

const common = (input: ProcessCommonInput) =>
  Object.freeze({
    cwd: input.cwdSemanticResourceDigest == null ? null : digest(input.cwdSemanticResourceDigest),
    environmentNamesDigest: digest(input.environmentNamesDigest),
    environmentScope: literal(input.environmentScope, ['processTree', 'runtime']),
    stdioDigest: digest(input.stdioDigest)
  })

export const canonicalizeProgramExecutableResource = (
  input: ProcessCommonInput & Readonly<{ argvDigest: unknown; executableId: unknown }>
): ProcessExecutableResourceV1 => {
  const shared = common(input)
  const executableId = identifier(input.executableId)
  const argvDigest = digest(input.argvDigest)
  const semanticResourceDigest = canonicalDigest([
    'processExecutable',
    'program',
    executableId,
    argvDigest,
    shared.cwd,
    shared.environmentScope,
    shared.environmentNamesDigest,
    shared.stdioDigest
  ])
  return Object.freeze({
    argvDigest,
    ...(shared.cwd == null ? {} : { cwdSemanticResourceDigest: shared.cwd }),
    display: resourceDisplay(input.label),
    environmentNamesDigest: shared.environmentNamesDigest,
    environmentScope: shared.environmentScope,
    executableId,
    invocation: 'program',
    kind: 'processExecutable',
    schemaVersion: 1,
    semanticId: `process-executable:${executableId}:${semanticResourceDigest.slice(0, 16)}`,
    semanticResourceDigest,
    stdioDigest: shared.stdioDigest
  })
}

export const canonicalizeShellExecutableResource = (
  input: ProcessCommonInput & Readonly<{ commandDigest: unknown; shellExecutableId: unknown }>
): ProcessExecutableResourceV1 => {
  const shared = common(input)
  const shellExecutableId = identifier(input.shellExecutableId)
  const commandDigest = digest(input.commandDigest)
  const semanticResourceDigest = canonicalDigest([
    'processExecutable',
    'shell',
    shellExecutableId,
    commandDigest,
    shared.cwd,
    shared.environmentScope,
    shared.environmentNamesDigest,
    shared.stdioDigest
  ])
  return Object.freeze({
    commandDigest,
    ...(shared.cwd == null ? {} : { cwdSemanticResourceDigest: shared.cwd }),
    display: resourceDisplay(input.label),
    environmentNamesDigest: shared.environmentNamesDigest,
    environmentScope: shared.environmentScope,
    invocation: 'shell',
    kind: 'processExecutable',
    schemaVersion: 1,
    semanticId: `process-executable:${shellExecutableId}:${semanticResourceDigest.slice(0, 16)}`,
    semanticResourceDigest,
    shellExecutableId,
    stdioDigest: shared.stdioDigest
  })
}

export const canonicalizeProcessInstanceResource = (
  input: Readonly<{
    executableSemanticResourceDigest: unknown
    generation: unknown
    label: unknown
    processResourceId: unknown
  }>
): ProcessInstanceResourceV1 => {
  const executableSemanticResourceDigest = digest(input.executableSemanticResourceDigest)
  const processResourceId = identifier(input.processResourceId)
  const generation = integer(input.generation, 1, Number.MAX_SAFE_INTEGER)
  const semanticResourceDigest = canonicalDigest([
    'processInstance',
    executableSemanticResourceDigest,
    processResourceId,
    generation
  ])
  return Object.freeze({
    display: resourceDisplay(input.label),
    executableSemanticResourceDigest,
    generation,
    kind: 'processInstance',
    processResourceId,
    schemaVersion: 1,
    semanticId: `process-instance:${processResourceId}:${generation}`,
    semanticResourceDigest
  })
}

const canonicalHostname = (value: unknown): string => {
  const input = string(value, 253).toLowerCase()
  let url: URL
  try {
    url = new URL(`http://${input}/`)
  } catch {
    throw new TypeError('Invalid process network endpoint')
  }
  if (url.hostname !== input || url.port !== '' || url.username !== '' || url.password !== '') {
    throw new TypeError('Invalid process network endpoint')
  }
  return input
}

export const canonicalizeProcessNetworkEndpointResource = (
  input: Readonly<{
    hostname: unknown
    label: unknown
    port: unknown
    transport: unknown
  }>
): ProcessNetworkEndpointResourceV1 => {
  const hostname = canonicalHostname(input.hostname)
  const port = integer(input.port, 1, 65_535)
  const transport = literal(input.transport, ['tcp', 'tls'])
  const semanticResourceDigest = canonicalDigest([
    'processNetworkEndpoint',
    transport,
    hostname,
    port
  ])
  return Object.freeze({
    display: resourceDisplay(input.label),
    hostname,
    kind: 'processNetworkEndpoint',
    port,
    schemaVersion: 1,
    semanticId: `process-network:${transport}:${hostname}:${port}`,
    semanticResourceDigest,
    transport
  })
}

export const bindInvocationResource = (
  input: InvocationBindingInputV1
): InvocationResourceBindingV1 => {
  const semanticResourceDigest = digest(input.semanticResourceDigest)
  const requestId = identifier(input.requestId)
  const generation = integer(input.generation, 1, Number.MAX_SAFE_INTEGER)
  const processId = identifier(input.processId)
  const operation = string(input.operation, 256)
  const subrequestId = input.subrequestId == null ? null : identifier(input.subrequestId)
  const hop = input.hop == null ? null : integer(input.hop, 0, Number.MAX_SAFE_INTEGER)
  const invocationBindingDigest = canonicalDigest([
    'invocation',
    semanticResourceDigest,
    processId,
    generation,
    requestId,
    subrequestId,
    hop,
    operation,
    digest(input.capabilityBindingDigest),
    digest(input.authorityDigest)
  ])
  return Object.freeze({
    generation,
    ...(hop == null ? {} : { hop }),
    invocationBindingDigest,
    requestId,
    semanticResourceDigest,
    ...(subrequestId == null ? {} : { subrequestId })
  })
}
