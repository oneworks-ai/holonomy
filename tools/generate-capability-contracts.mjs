import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { capabilityContractArtifacts } from './capability-contract-artifacts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = resolve(root, 'src/capability-runtime/machine')
const check = process.argv.includes('--check')
const json = value => `${JSON.stringify(value, null, 2)}\n`

const main = async () => {
  const artifacts = capabilityContractArtifacts(root)
  const failures = []
  for (const [name, value] of artifacts) {
    const path = resolve(outputRoot, name)
    const expected = json(value)
    if (check) {
      let actual
      try {
        actual = await readFile(path, 'utf8')
      } catch {
        failures.push(`${name} is missing`)
        continue
      }
      if (actual !== expected) failures.push(`${name} differs from its machine owner`)
    } else {
      await writeFile(path, expected)
    }
  }

  if (failures.length > 0) throw new Error(failures.join('\n'))
  process.stdout.write(
    `Capability contracts ${check ? 'verified' : 'generated'}: ${artifacts.size} artifacts\n`
  )
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
