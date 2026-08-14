import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  CapabilityContractError,
  HOST_SYSTEM_PROJECTION_V1_SCHEMA,
  compileHostSystemProjectionV1,
  unavailableHostSystemProjectionV1
} from '../../../src/capability-runtime/index.js'

const projection = () => ({
  fields: {
    'os.arch': { mode: 'real', precision: 'exact', value: 'arm64' },
    'os.availableParallelism': { mode: 'real', precision: 'coarse', value: 5 },
    'os.cpus': {
      mode: 'synthetic',
      precision: 'coarse',
      value: [{
        model: 'Host CPU',
        speed: 3344,
        times: { idle: 5, irq: 4, nice: 3, sys: 2, user: 1 }
      }]
    },
    'os.hostname': { mode: 'redacted', precision: 'redacted', value: 'secret-host' },
    'os.networkInterfaces': {
      mode: 'real',
      precision: 'coarse',
      value: {
        en0: [{
          address: '192.0.2.1',
          cidr: '192.0.2.1/24',
          family: 'IPv4',
          internal: false,
          mac: 'aa:bb:cc:dd:ee:ff',
          netmask: '255.255.255.0'
        }]
      }
    },
    'process.cwd': { mode: 'synthetic', precision: 'exact', value: 'holo-fs://workspace/' },
    'process.env': { mode: 'redacted', precision: 'redacted', value: { SECRET: 'value' } },
    'process.pid': { mode: 'redacted', precision: 'redacted', value: 9182 }
  },
  schemaVersion: 1
})

describe('host system projection v1 machine contract', () => {
  it('defaults every omitted field to unavailable without reading ambient OS', () => {
    const value = unavailableHostSystemProjectionV1()
    expect(value).toEqual({ fields: {}, schemaVersion: 1 })
    expect(Object.isFrozen(value.fields)).toBe(true)
  })

  it('normalizes exact, coarse and redacted values deterministically', () => {
    const compiled = compileHostSystemProjectionV1(projection())
    expect(compiled.fields['os.arch']).toEqual({ mode: 'real', precision: 'exact', value: 'arm64' })
    expect(compiled.fields['os.availableParallelism']).toEqual({ mode: 'real', precision: 'coarse', value: 8 })
    expect(compiled.fields['os.cpus']).toEqual({
      mode: 'synthetic',
      precision: 'coarse',
      value: [{ model: 'unknown', speed: 3300, times: { idle: 0, irq: 0, nice: 0, sys: 0, user: 0 } }]
    })
    expect(compiled.fields['os.hostname']).toEqual({ mode: 'redacted', precision: 'redacted', value: 'sandbox' })
    expect(compiled.fields['process.pid']).toEqual({ mode: 'redacted', precision: 'redacted', value: 1 })
    expect(compiled.fields['process.env']).toEqual({ mode: 'redacted', precision: 'redacted', value: {} })
    expect(compiled.fields['os.networkInterfaces']).toEqual({
      mode: 'real',
      precision: 'coarse',
      value: {
        'interface-1': [{
          address: '0.0.0.0',
          cidr: null,
          family: 'IPv4',
          internal: false,
          mac: '00:00:00:00:00:00',
          netmask: '0.0.0.0'
        }]
      }
    })
  })

  it('matches the checked-in structural JSON Schema', () => {
    const validate = new Ajv2020({ strict: true }).compile(HOST_SYSTEM_PROJECTION_V1_SCHEMA)
    const compiled = compileHostSystemProjectionV1(projection())
    expect(validate(compiled)).toBe(true)
  })

  it.each([
    [{ fields: { 'os.hostname': { mode: 'unavailable', precision: 'none', value: 'leak' } }, schemaVersion: 1 }],
    [{ fields: { 'os.hostname': { mode: 'real', precision: 'redacted', value: 'host' } }, schemaVersion: 1 }],
    [{
      fields: { 'process.cwd': { mode: 'synthetic', precision: 'exact', value: '/Users/secret' } },
      schemaVersion: 1
    }],
    [{
      fields: {
        'os.networkInterfaces': {
          mode: 'real',
          precision: 'exact',
          value: {
            en0: [{
              address: '192.168.001.1',
              cidr: null,
              family: 'IPv4',
              internal: false,
              mac: 'AA:BB:CC:DD:EE:FF',
              netmask: '255.255.255.0'
            }]
          }
        }
      },
      schemaVersion: 1
    }],
    [{
      fields: { 'process.env': { mode: 'synthetic', precision: 'exact', value: { 'BAD-KEY': 'x' } } },
      schemaVersion: 1
    }]
  ])('rejects illegal discriminants, native paths and noncanonical identities', value => {
    expect(() => compileHostSystemProjectionV1(value)).toThrow(CapabilityContractError)
  })
})
