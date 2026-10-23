/* eslint-disable perfectionist/sort-imports, antfu/no-top-level-await -- Native package alias order and await are intentional. */
import * as minimatchAlias from '#match'
import * as acornAlias from '#parser'
import * as acorn from 'acorn'
import { minimatch } from 'minimatch'
import assert from 'node:assert/strict'

assert.strictEqual(acorn, acornAlias)
assert.strictEqual(minimatch, minimatchAlias.minimatch)
const ast = acorn.parse('const answer = 42;', { ecmaVersion: 2020 })
assert.strictEqual(ast.body[0].declarations[0].init.value, 42)
assert.strictEqual(minimatch('src/a.ts', 'src/{a,b}.ts'), true)
assert.strictEqual(minimatch('src/c.ts', 'src/{a,b}.ts'), false)

const again = await import('acorn')
assert.strictEqual(again, acorn)
