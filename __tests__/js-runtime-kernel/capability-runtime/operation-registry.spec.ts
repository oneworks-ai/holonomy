import { createHash } from 'node:crypto'

import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_ERROR_MAP_V1,
  DEVICE_OPERATIONS_V1,
  FACADE_DELIVERY_REGISTRY_V1,
  OPERATION_REGISTRY_V1,
  OPERATION_SCHEMA_OWNER_REGISTRY_V1,
  SYSTEM_INFORMATION_FIELDS_V1,
  buildNetworkInvocationSnapshotV1,
  normalizeNetworkInvocationSnapshotV1,
  normalizeNetworkRedirectInvocationV1,
  operationRegistryJsonV1,
  operationRegistryMarkdownV1,
  validateOperationRegistryV1
} from '../../../src/capability-runtime/index.js'
import type { InternalCapabilityCodeV1, OperationDescriptorV1 } from '../../../src/capability-runtime/index.js'

const clone = (registry = OPERATION_REGISTRY_V1): OperationDescriptorV1[] => registry.map(row => ({ ...row }))
const owners = new Map(OPERATION_SCHEMA_OWNER_REGISTRY_V1.map(item => [item.schemaId, item]))
const validateSchema = (schemaId: string, value: unknown): boolean => {
  const schema = owners.get(schemaId)?.schema
  if (schema == null) throw new Error(`Missing schema ${schemaId}`)
  return Boolean(new Ajv2020({ strict: true }).compile(schema)(value))
}
const selectedResultSchema = (row: OperationDescriptorV1, args: unknown): string => {
  const matches = row.resultVariants?.filter(variant => validateSchema(variant.whenArgumentsSchemaId, args)) ?? []
  if (matches.length !== 1) throw new Error(`Expected one result variant for ${row.member}`)
  return matches[0]!.resultSchemaId
}

describe('capability operation registry v1', () => {
  it('is exhaustive across every closed operation family', () => {
    expect(() => validateOperationRegistryV1()).not.toThrow()
    expect(new Set(OPERATION_REGISTRY_V1.map(row => row.operation)))
      .toEqual(expect.objectContaining(new Set(DEVICE_OPERATIONS_V1)))
    expect(OPERATION_REGISTRY_V1.filter(row => row.module === 'node:os' || row.module === 'node:process'))
      .toHaveLength(SYSTEM_INFORMATION_FIELDS_V1.length)
  })

  it('owns exact critical rows instead of operation-name presence only', () => {
    expect(OPERATION_REGISTRY_V1).toEqual(expect.arrayContaining([
      expect.objectContaining({
        argsSchemaId: 'FsReadFileSyncArgsV1',
        deliverySchemaId: 'SyncVariantDeliveryV1',
        interception: 'host',
        member: 'readFileSync',
        modes: ['sync'],
        module: 'node:fs',
        operation: 'filesystem.file.read',
        resourceSchemaId: 'FilesystemResourceV1'
      }),
      expect.objectContaining({
        capability: { kind: 'inherited' },
        interception: 'systemOnly',
        member: 'Response.text',
        operation: 'network.response.body.read'
      }),
      expect.objectContaining({
        deliverySchemaId: 'ProcessExecDeliveryV1',
        member: 'exec',
        operation: 'process.shell.spawn',
        resultSchemaId: 'ChildProcessFacadeV1'
      }),
      expect.objectContaining({
        member: 'getCellularState',
        module: 'holo:device',
        operation: 'device.connectivity.cellular.state.read'
      }),
      expect.objectContaining({
        member: 'getWifiState',
        module: 'holo:device',
        operation: 'device.connectivity.wifi.state.read'
      }),
      expect.objectContaining({
        member: 'getWifiIdentity',
        module: 'holo:device/promises',
        operation: 'device.connectivity.wifi.identity.read'
      })
    ]))
  })

  it('rejects missing operations, unowned schemas and system-only widening', () => {
    expect(() =>
      validateOperationRegistryV1(
        clone().filter(row => row.operation !== 'device.summary.read')
      )
    ).toThrow(/Device Registry missing/u)

    const unowned = clone()
    unowned[0] = { ...unowned[0]!, resultSchemaId: '' }
    expect(() => validateOperationRegistryV1(unowned)).toThrow(/unowned schema/u)

    const widened = clone()
    const index = widened.findIndex(row => row.interception === 'systemOnly')
    widened[index] = {
      ...widened[index]!,
      capability: {
        anyOf: [{
          allOf: [{ name: 'host.fs', version: 1 }],
          branchId: 'wrong'
        }]
      }
    }
    expect(() => validateOperationRegistryV1(widened)).toThrow(/must inherit/u)
  })

  it('generates stable machine JSON and markdown from the same owner', () => {
    const json = operationRegistryJsonV1()
    const markdown = operationRegistryMarkdownV1()
    const parsed = JSON.parse(json) as unknown[]

    expect(parsed).toHaveLength(OPERATION_REGISTRY_V1.length)
    expect(markdown.split('\n').filter(line => line.startsWith('| '))).toHaveLength(
      OPERATION_REGISTRY_V1.length + 2
    )
    expect(markdown).toContain('| Args | Result | Result variants | Delivery | Resource | Limits |')
    expect(markdown).toContain('| ProcessExecDeliveryV1 | ProcessExecutableResourceV1→ProcessInstanceResourceV1 |')
    expect(createHash('sha256').update(json).digest('hex')).toMatch(/^[\da-f]{64}$/u)
  })

  it('owns every Registry schema id and locks exact System row semantics', () => {
    const schemaIds = new Set(OPERATION_SCHEMA_OWNER_REGISTRY_V1.map(item => item.schemaId))
    for (const row of OPERATION_REGISTRY_V1) {
      for (
        const id of [
          row.argsSchemaId,
          row.deliverySchemaId,
          row.resourceSchemaId,
          row.resultSchemaId
        ]
      ) expect(schemaIds.has(id)).toBe(true)
    }
    expect(OPERATION_REGISTRY_V1.find(row => row.module === 'node:process' && row.member === 'cwd')).toEqual(
      expect.objectContaining({ kind: 'read', operation: 'system.process.cwd.read' })
    )
    expect(() =>
      validateOperationRegistryV1(
        OPERATION_REGISTRY_V1.map((row, index) => index === 0 ? { ...row, argsSchemaId: 'DefinitelyNotOwnedV1' } : row)
      )
    ).toThrow(/unowned schema/u)

    const roleSwapped = clone()
    const readFileSync = roleSwapped.findIndex(row => row.module === 'node:fs' && row.member === 'readFileSync')
    roleSwapped[readFileSync] = {
      ...roleSwapped[readFileSync]!,
      resultSchemaId: 'FsReadFileSyncArgsV1'
    }
    expect(() => validateOperationRegistryV1(roleSwapped)).toThrow(/result schema role/u)

    const deliveryDrift = clone()
    const exec = deliveryDrift.findIndex(row => row.module === 'node:child_process' && row.member === 'exec')
    deliveryDrift[exec] = {
      ...deliveryDrift[exec]!,
      deliverySchemaId: 'SyncVoidDeliveryV1'
    }
    expect(() => validateOperationRegistryV1(deliveryDrift)).toThrow(/delivery.*mode/u)
  })

  it('owns executable schemas and every nested delivery reference', () => {
    for (const owner of owners.values()) {
      expect(owner.schema).toBeTypeOf('object')
      expect(Object.keys(owner.schema).length).toBeGreaterThan(0)
      expect(() => new Ajv2020({ strict: true }).compile(owner.schema)).not.toThrow()
    }
    for (const delivery of Object.values(FACADE_DELIVERY_REGISTRY_V1)) {
      if (delivery.kind === 'resourceEvents') {
        expect(owners.get(delivery.eventSchemaId)?.roles).toContain('event')
        continue
      }
      if (delivery.immediateResultSchemaId != null) {
        expect(owners.get(delivery.immediateResultSchemaId)?.roles).toContain('result')
      }
      if (delivery.resourceEvents != null) {
        expect(owners.get(delivery.resourceEvents.eventSchemaId)?.roles).toContain('event')
      }
      if (delivery.callback?.success.kind === 'tuple') {
        expect(owners.get(delivery.callback.success.tupleSchemaId)?.roles).toContain('tuple')
      }
      if (delivery.callback?.failure.kind === 'errorAndTuple') {
        expect(owners.get(delivery.callback.failure.tupleSchemaId)?.roles).toContain('tuple')
      }
    }
  })

  it('validates exact Process argument and result schemas', () => {
    expect(validateSchema('ProcessProgramSpawnArgsV1', {
      environmentScope: 'processTree',
      executableId: 'git'
    })).toBe(true)
    expect(validateSchema('ProcessProgramSpawnArgsV1', {
      args: ['status'],
      environmentScope: 'runtime',
      executableId: 'git'
    })).toBe(true)
    expect(validateSchema('ProcessProgramSpawnArgsV1', {
      executableId: 'git',
      environmentScope: 'processTree',
      options: { args: ['status'] }
    })).toBe(false)
    expect(validateSchema('ProcessExecFileArgsV1', {
      environmentScope: 'processTree',
      executableId: 'git'
    })).toBe(true)
    expect(validateSchema('ProcessExecFileArgsV1', {
      args: ['status'],
      environmentScope: 'processTree',
      executableId: 'git'
    })).toBe(true)
    expect(validateSchema('ProcessExecFileArgsV1', {
      executableId: 'git',
      environmentScope: 'processTree',
      options: { stdio: ['pipe', 'pipe', 'pipe'] }
    })).toBe(false)
    expect(validateSchema('ProcessExecArgsV1', {
      command: 'printf ok',
      environmentScope: 'processTree',
      options: { encoding: 'utf8', shellExecutableId: 'sh' }
    })).toBe(true)
    expect(validateSchema('ProcessShellSpawnArgsV1', {
      command: 'printf ok',
      environmentScope: 'processTree',
      options: { shell: true, shellExecutableId: 'sh' }
    })).toBe(true)
    expect(validateSchema('ProcessSyncResultV1', {
      error: {
        code: 'EIO',
        message: 'Process failed',
        name: 'Error',
        retryable: false
      },
      pid: 7,
      signal: null,
      status: 1,
      stderr: 'failure',
      stdout: ''
    })).toBe(true)
  })

  it('binds filesystem argument branches to exact result schemas', () => {
    const row = (member: string, mode: string) => {
      const result = OPERATION_REGISTRY_V1.find(item => item.member === member && item.modes[0] === mode)
      if (result == null) throw new Error(`Missing row ${member}/${mode}`)
      return result
    }
    const path = 'holo-fs://workspace/file.txt'
    const read = row('readFileSync', 'sync')
    expect(selectedResultSchema(read, { path })).toBe('RuntimeBufferV1')
    expect(selectedResultSchema(read, { options: { encoding: 'utf8' }, path })).toBe('string')
    expect(validateSchema(read.argsSchemaId, {
      options: { encoding: 'utf8', signal: { bindingId: 'abort', generation: 1 } },
      path
    })).toBe(false)
    expect(selectedResultSchema(row('readdirSync', 'sync'), {
      options: { withFileTypes: true },
      path: 'holo-fs://workspace/'
    })).toBe('FsReaddirDirentsResultV1')
    expect(selectedResultSchema(row('mkdirSync', 'sync'), {
      path: 'holo-fs://workspace/new'
    })).toBe('void')
    expect(selectedResultSchema(row('mkdirSync', 'sync'), {
      options: { recursive: true },
      path: 'holo-fs://workspace/new'
    })).toBe('FsMkdirRecursiveResultV1')
    expect(validateSchema('FsReaddirNamesResultV1', [{ kind: 'file', name: 'x' }])).toBe(false)
    expect(validateSchema('FsMkdirRecursiveResultV1', {
      kind: 'path',
      value: 'holo-fs://workspace/new'
    })).toBe(true)
  })

  it('owns complete normalized Network request and redirect snapshots', () => {
    const request = buildNetworkInvocationSnapshotV1({
      headers: [['accept', 'application/json']],
      hop: 0,
      label: 'api.example/profile',
      logicalRequestId: 'request-1',
      method: 'GET',
      url: 'https://api.example/profile?token=secret'
    })
    const redirected = buildNetworkInvocationSnapshotV1({
      headers: [['accept', 'application/json']],
      hop: 1,
      label: 'api.example/next',
      logicalRequestId: 'request-1',
      method: 'GET',
      url: 'https://api.example/next?token=secret'
    })
    expect(validateSchema('NetworkInvocationSnapshotV1', request)).toBe(true)
    expect(validateSchema('NetworkInvocationSnapshotV1', {
      ...request,
      body: { kind: 'none', length: 1, sha256: '0'.repeat(64) }
    })).toBe(false)
    expect(validateSchema('NetworkRedirectInvocationV1', {
      bodyReplay: 'none',
      fromHop: 0,
      fromRequest: request,
      logicalRequestId: 'request-1',
      methodRewritten: false,
      status: 302,
      toHop: 1,
      toRequest: redirected
    })).toBe(true)
    expect(validateSchema('NetworkRedirectInvocationV1', {
      fromHop: 0,
      logicalRequestId: 'request-1',
      toHop: 1
    })).toBe(false)
    expect(() =>
      normalizeNetworkInvocationSnapshotV1({
        ...request,
        headers: [{ index: 0, name: 'accept', value: 'text/plain', visibility: 'visible' }]
      })
    ).toThrow(/Invalid Holonomy capability configuration/u)
    expect(() =>
      normalizeNetworkInvocationSnapshotV1({
        ...request,
        query: [{ index: 0, key: 'page', value: '2', visibility: 'visible' }]
      })
    ).toThrow(/Invalid Holonomy capability configuration/u)
    expect(() =>
      normalizeNetworkRedirectInvocationV1({
        bodyReplay: 'none',
        fromHop: 0,
        fromRequest: request,
        logicalRequestId: 'request-1',
        methodRewritten: true,
        status: 307,
        toHop: 1,
        toRequest: { ...redirected, method: 'POST' }
      })
    ).toThrow(/Invalid Holonomy capability configuration/u)
    expect(() =>
      normalizeNetworkRedirectInvocationV1({
        bodyReplay: 'same-buffered-body',
        fromHop: 0,
        fromRequest: request,
        logicalRequestId: 'request-1',
        methodRewritten: false,
        status: 307,
        toHop: 1,
        toRequest: redirected
      })
    ).toThrow(/Invalid Holonomy capability configuration/u)
  })

  it('exhaustively maps every internal terminal to node and holo errors', () => {
    const codes = Object.keys(CAPABILITY_ERROR_MAP_V1) as InternalCapabilityCodeV1[]
    expect(codes).toHaveLength(25)
    for (const code of codes) {
      expect(CAPABILITY_ERROR_MAP_V1[code].nodeFs).toMatch(/^(?:E|ABORT_)/u)
      expect(CAPABILITY_ERROR_MAP_V1[code].nodeSystem).toMatch(/^(?:E|ABORT_)/u)
      expect(CAPABILITY_ERROR_MAP_V1[code].childProcess.default).toMatch(/^(?:E|ABORT_)/u)
      expect(CAPABILITY_ERROR_MAP_V1[code].holo).toMatch(/^holo\./u)
    }
    expect(CAPABILITY_ERROR_MAP_V1['policy.denied']).toEqual({
      childProcess: { default: 'EACCES' },
      holo: 'holo.policy_denied',
      nodeFs: 'EACCES',
      nodeSystem: 'ERR_ACCESS_DENIED'
    })
    expect(CAPABILITY_ERROR_MAP_V1['middleware.permission_denied'].holo)
      .toBe('holo.permission_denied')
    expect(CAPABILITY_ERROR_MAP_V1['resource.byte_limit'].childProcess).toEqual({
      capturedOutput: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      default: 'ERR_OUT_OF_RANGE',
      stdinWrite: 'EFBIG'
    })
  })
})
