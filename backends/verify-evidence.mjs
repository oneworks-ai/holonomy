import { readFile } from 'node:fs/promises'
import process from 'node:process'

const evidenceFiles = [
  'backends/agentos/evidence/2026-08-16-darwin-arm64-node22.json',
  'backends/wasix/evidence/2026-08-16-current-darwin-arm64-node22.json',
  'backends/wasix/evidence/2026-08-16-compatibility-darwin-arm64-node22.json'
]

const main = async () => {
  const module = await import('../dist/capability-runtime/index.js')
  for (const file of evidenceFiles) {
    module.normalizeProcessBackendProbeEvidenceV1(JSON.parse(await readFile(file, 'utf8')))
    process.stdout.write(`validated=${file}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
