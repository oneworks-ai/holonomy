import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RFC_CONTRACT_FILES, verifyRfcContract } from './verify-rfc-contract-support.mjs'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const result = await verifyRfcContract(
  resolve(repositoryRoot, '.oo/rules/rfcs')
)
process.stdout.write(
  `RFC contract verified: ${RFC_CONTRACT_FILES.length} files, ${result.declarations} normative types\n`
)
