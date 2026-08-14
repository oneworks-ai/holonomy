import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { normalizeProcessBackendProbeEvidenceV1 } from '../../../src/capability-runtime/index.js'

const evidenceFiles = [
  'agentos-node-darwin-arm64.json',
  'v86-android-emulator-arm64.json',
  'v86-node-darwin-arm64.json',
  'wasix-0.10-node-darwin-arm64.json',
  'wasix-0.9-node-darwin-arm64.json'
] as const

const evidenceRoot = new URL('../../../tests/fixtures/process-backend-probes/', import.meta.url)

describe('process Backend probe evidence', () => {
  it.each(evidenceFiles)('keeps %s canonical and machine-readable', file => {
    const path = fileURLToPath(new URL(file, evidenceRoot))
    const input = JSON.parse(readFileSync(path, 'utf8')) as unknown

    expect(normalizeProcessBackendProbeEvidenceV1(input)).toEqual(input)
  })

  it('does not reuse a backend and Host identity', () => {
    const identities = evidenceFiles.map(file => {
      const input = JSON.parse(readFileSync(fileURLToPath(new URL(file, evidenceRoot)), 'utf8')) as {
        artifact: { artifactVersion: string }
        backendId: string
        host: { architecture: string; engine: string; platform: string }
      }
      return [
        input.backendId,
        input.artifact.artifactVersion,
        input.host.platform,
        input.host.architecture,
        input.host.engine
      ].join(':')
    })

    expect(new Set(identities).size).toBe(identities.length)
  })
})
