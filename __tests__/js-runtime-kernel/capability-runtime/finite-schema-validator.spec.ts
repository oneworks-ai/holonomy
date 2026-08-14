import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  OPERATION_SCHEMA_OWNER_REGISTRY_V1,
  validateFiniteJsonSchemaV1
} from '../../../src/capability-runtime/index.js'

const samples = [
  undefined,
  null,
  false,
  true,
  -1,
  0,
  1,
  256,
  '',
  'utf8',
  'holo-fs://workspace/file.txt',
  [],
  [null],
  ['read'],
  {},
  { access: 'none' },
  {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: { charging: false, hasBattery: true, levelPercent: 50, lowPowerMode: false, source: 'battery' }
  },
  {
    observedAt: 100,
    precision: 'standard',
    revision: 1,
    status: 'available',
    value: { charging: true, hasBattery: false, lowPowerMode: false, source: 'battery' }
  },
  { options: { encoding: 'utf8' }, path: 'holo-fs://workspace/file.txt' }
]

describe('finite operation schema validator', () => {
  it('matches Ajv for every operation schema owner over boundary samples', () => {
    for (const owner of OPERATION_SCHEMA_OWNER_REGISTRY_V1) {
      const validateAjv = new Ajv2020({ strict: true }).compile(owner.schema)
      for (const sample of samples) {
        expect(
          validateFiniteJsonSchemaV1(owner.schema, sample),
          `${owner.schemaId}: ${JSON.stringify(sample)}`
        ).toBe(validateAjv(sample))
      }
    }
  })

  it('rejects an unknown schema keyword', () => {
    expect(validateFiniteJsonSchemaV1({ futureKeyword: true }, null)).toBe(false)
  })
})
