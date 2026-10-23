import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  CAPABILITY_REQUIREMENT_V1_SCHEMA,
  canonicalVirtualPath,
  capabilitySatisfiesV1,
  normalizeCapabilityRequirementV1
} from '../../../src/capability-runtime/index.js'

const constraints = (segments: readonly string[]) => ({
  limits: {
    maxDirectoryEntries: 64,
    maxOpenHandles: 8,
    maxQueuedEvents: 0,
    maxReadBytes: 4096,
    maxWatchers: 0,
    maxWriteBytes: 4096
  },
  roots: [{ pathPrefixSegments: segments, rights: ['read'], rootId: 'workspace', symlinks: 'deny' }]
})
const requirement = (segments: readonly string[]) => ({
  anyOf: [{
    allOf: [{ constraints: constraints(segments), name: 'host.fs', version: 1 }],
    branchId: 'filesystem'
  }]
})
const validate = new Ajv2020({ strict: true }).compile(CAPABILITY_REQUIREMENT_V1_SCHEMA)
const accepts = (segment: string) => {
  try {
    normalizeCapabilityRequirementV1(requirement([segment]))
    return true
  } catch {
    return false
  }
}

describe('canonical filesystem capability prefix segments', () => {
  it('accepts hidden, punctuation and canonical encoded filenames without identifier narrowing', () => {
    for (
      const segments of [
        ['git-probe', '.git'],
        ['.npmrc'],
        ['-leading'],
        ["!()'"],
        ['two%20words', '%E4%B8%AD%E6%96%87', '%F0%9F%93%81'],
        ['%252F'],
        ['%20'.repeat(255)]
      ]
    ) {
      expect(() => normalizeCapabilityRequirementV1(requirement(segments)), segments.join('/')).not.toThrow()
      expect(validate(requirement(segments)), segments.join('/')).toBe(true)
    }
    expect(capabilitySatisfiesV1('host.fs', constraints([]), constraints(['git-probe', '.git']))).toBe(true)
    expect(capabilitySatisfiesV1('host.fs', constraints(['.git']), constraints(['.git-credentials']))).toBe(false)
  })

  it('rejects traversal, noncanonical bytes and names outside the per-segment byte bound', () => {
    for (
      const segment of [
        '',
        '.',
        '..',
        '/',
        'a/b',
        '\\',
        '\0',
        'raw space',
        '%00',
        '%2F',
        '%5C',
        '%2e',
        '%41',
        '%2f',
        '%',
        '%FF',
        '%C0%AF',
        '%E0%80%80',
        '%ED%A0%80',
        '%F4%90%80%80',
        '\uD800',
        'a'.repeat(256),
        '%20'.repeat(256)
      ]
    ) {
      expect(accepts(segment), JSON.stringify(segment)).toBe(false)
      expect(validate(requirement([segment])), JSON.stringify(segment)).toBe(false)
    }
  })

  it('keeps the standalone machine schema aligned with canonical URI segment rules', () => {
    const scalars = [0x80, 0x7FF, 0x800, 0xD7FF, 0xE000, 0xFFFF, 0x10000, 0x10FFFF]
    for (let scalar = 1; scalar <= 0x10FFFF; scalar += 977) scalars.push(scalar)
    for (const scalar of scalars) {
      if (scalar >= 0xD800 && scalar <= 0xDFFF || scalar === 47 || scalar === 92) continue
      const segment = encodeURIComponent(String.fromCodePoint(scalar))
      expect(canonicalVirtualPath(`holo-fs://workspace/${segment}`)).toBe(`holo-fs://workspace/${segment}`)
      expect(accepts(segment), segment).toBe(true)
      expect(validate(requirement([segment])), segment).toBe(true)
    }
    for (let byte = 0; byte <= 255; byte++) {
      const segment = `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      let canonical = false
      try {
        canonical = canonicalVirtualPath(`holo-fs://workspace/${segment}`) === `holo-fs://workspace/${segment}`
      } catch { /* Invalid URI bytes must fail both validators. */ }
      expect(accepts(segment), segment).toBe(canonical)
      expect(validate(requirement([segment])), segment).toBe(canonical)
    }
  })
})
