/* eslint-disable no-console, perfectionist/sort-imports -- Guest stdout and Native package imports are intentional. */
import { parse } from 'acorn'
import assert from 'node:assert/strict'
assert.strictEqual(parse('42', { ecmaVersion: 2020 }).body[0].expression.value, 42)
console.log('ACORN_OK')
