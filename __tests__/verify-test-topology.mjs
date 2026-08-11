import { readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsRoot = fileURLToPath(new URL('.', import.meta.url))
const layers = Object.freeze({
  cli: 'cli/',
  js: 'js-api/',
  runtime: 'js-runtime-kernel/'
})

const filesBelow = directory =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = resolve(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })

const specs = filesBelow(testsRoot)
  .filter(file => file.endsWith('.spec.ts'))
  .map(file => relative(testsRoot, file).replaceAll('\\', '/'))
  .sort()

const counts = Object.fromEntries(Object.keys(layers).map(layer => [layer, 0]))
const errors = []
for (const spec of specs) {
  const owners = Object.entries(layers).filter(([, prefix]) => spec.startsWith(prefix))
  if (owners.length !== 1) errors.push(`${spec}: expected exactly one test layer, found ${owners.length}`)
  else counts[owners[0][0]] += 1
}
for (const [layer, count] of Object.entries(counts)) {
  if (count === 0) errors.push(`${layer}: layer must own at least one spec`)
}
if (errors.length > 0) throw new Error(`Invalid test topology:\n${errors.join('\n')}`)

process.stdout.write(`Test topology: ${specs.length} specs (${
  Object.entries(counts)
    .map(([layer, count]) => `${layer}=${count}`)
    .join(', ')
})\n`)
