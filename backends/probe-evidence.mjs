import { writeFile } from 'node:fs/promises'
import process from 'node:process'

const architecture = () => {
  if (process.arch === 'ia32') return 'x86'
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`Unsupported probe architecture: ${process.arch}`)
}

const platform = () => {
  if (['darwin', 'linux', 'win32'].includes(process.platform)) return process.platform
  throw new Error(`Unsupported probe platform: ${process.platform}`)
}

export const nodeV8Host = () => ({
  architecture: architecture(),
  engine: 'node-v8',
  engineVersion: process.versions.v8,
  platform: platform(),
  runtimeVersion: process.versions.node
})

export const publishEvidence = async evidence => {
  const module = await import('../dist/capability-runtime/index.js')
  const normalized = module.normalizeProcessBackendProbeEvidenceV1(evidence)
  const json = `${JSON.stringify(normalized, null, 2)}\n`
  const outputIndex = process.argv.indexOf('--output')
  if (outputIndex >= 0) {
    const outputPath = process.argv[outputIndex + 1]
    if (!outputPath) throw new Error('--output requires a path')
    await writeFile(outputPath, json)
    process.stderr.write(`evidence=${outputPath}\n`)
  }
  process.stdout.write(json)
}

export const observation = (capability, status, provenance, reasonCode) => ({
  capability,
  provenance,
  ...(reasonCode == null ? {} : { reasonCode }),
  status
})
