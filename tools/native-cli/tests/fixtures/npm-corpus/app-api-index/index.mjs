/* eslint-disable no-console, node/prefer-global/process -- Guest CLI output and argv are under test. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

import { parse } from 'acorn'

assert.equal(process.versions.node, undefined)
const [input, expectedVersion] = process.argv.slice(2)
assert.equal(process.argv.length, 4)
assert.equal(expectedVersion, '2022')
const source = fs.readFileSync(input, 'utf8')
let ast
try {
  ast = parse(source, { ecmaVersion: Number(expectedVersion), sourceType: 'module', locations: true })
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error
  console.error(`SOURCE_INVALID:${error.loc.line}:${error.loc.column}`)
  process.exit(3)
}
const exports = []
for (const statement of ast.body) {
  if (statement.type === 'ExportDefaultDeclaration') exports.push({ name: 'default', line: statement.loc.start.line })
  if (statement.type !== 'ExportNamedDeclaration') continue
  if (statement.declaration?.type === 'VariableDeclaration') {
    for (const declaration of statement.declaration.declarations) {
      exports.push({ name: declaration.id.name, line: statement.loc.start.line })
    }
  } else if (statement.declaration?.id) {
    exports.push({ name: statement.declaration.id.name, line: statement.loc.start.line })
  }
  for (const specifier of statement.specifiers) {
    exports.push({ name: specifier.exported.name, line: statement.loc.start.line })
  }
}
exports.sort((left, right) => left.name.localeCompare(right.name))
const sha256 = createHash('sha256').update(source).digest('hex')
fs.writeFileSync('holo-fs://workspace/api-index.json', JSON.stringify({ exports, sha256 }))
console.log('API_INDEX_OK')
