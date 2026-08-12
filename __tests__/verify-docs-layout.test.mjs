/* eslint-disable test/no-import-node-test */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import { verifyDocsLayout } from './verify-docs-layout.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

const fixture = async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'holonomy-docs-check-'))
  roots.push(root)
  await mkdir(resolve(root, 'en'), { recursive: true })
  const chinese = [
    '# 中文',
    '',
    '[English](./en/index.md)',
    '',
    '## Part',
    '',
    '[nested](<./index.md?view=(all)#part>), [reference][part], and shortcut [part].',
    '',
    '[part]: #part'
  ].join('\n')
  const english = chinese
    .replace('# 中文', '# English')
    .replace('[English](./en/index.md)', '[简体中文](../index.md)')
  writeFileSync(resolve(root, 'index.md'), chinese)
  writeFileSync(resolve(root, 'en/index.md'), english)
  return root
}

test('accepts paired Markdown with anchors, references, query, and nested parentheses', async () => {
  const root = await fixture()
  assert.deepEqual(verifyDocsLayout(root).errors, [])
})

test('rejects symbolic links even when their targets are readable', async () => {
  const root = await fixture()
  const outside = resolve(root, '..', `${root.split('/').at(-1)}-outside.md`)
  writeFileSync(outside, '# outside')
  roots.push(outside)
  symlinkSync(outside, resolve(root, 'outside.md'))
  assert.match(verifyDocsLayout(root).errors.join('\n'), /symbolic links are forbidden/u)
})

test('rejects hidden, active, and unapproved authored files', async () => {
  const root = await fixture()
  writeFileSync(resolve(root, '.draft.md'), '# draft')
  writeFileSync(resolve(root, 'diagram.svg'), '<svg/>')
  writeFileSync(resolve(root, 'embed.html'), '<script></script>')
  const errors = verifyDocsLayout(root).errors.join('\n')
  assert.match(errors, /hidden documentation paths are forbidden/u)
  assert.match(errors, /diagram\.svg: file type or media location is not allowed/u)
  assert.match(errors, /embed\.html: file type or media location is not allowed/u)
})

test('rejects uppercase authored paths instead of skipping public-page validation', async () => {
  const root = await fixture()
  writeFileSync(resolve(root, 'Page.MD'), '# skipped')
  assert.match(verifyDocsLayout(root).errors.join('\n'), /authored paths must use lowercase ASCII kebab-case/u)
})

test('keeps content inside a longer backtick fence out of link validation', async () => {
  const root = await fixture()
  const block = ['````md', '[not a link](missing.md)', '```', '````'].join('\n')
  for (const page of ['index.md', 'en/index.md']) {
    writeFileSync(resolve(root, page), `${readFileSync(resolve(root, page), 'utf8')}\n\n${block}\n`)
  }
  assert.deepEqual(verifyDocsLayout(root).errors, [])
})

test('rejects locale-paired Mermaid blocks with different topology', async () => {
  const root = await fixture()
  const graph = '\n\n```mermaid\nflowchart LR\n  first["One"] --> second["Two"]\n```\n'
  const changed = '\n\n```mermaid\nflowchart LR\n  first["One"] --> third["Three"]\n```\n'
  writeFileSync(resolve(root, 'index.md'), `${readFileSync(resolve(root, 'index.md'), 'utf8')}${graph}`)
  writeFileSync(resolve(root, 'en/index.md'), `${readFileSync(resolve(root, 'en/index.md'), 'utf8')}${changed}`)
  assert.match(verifyDocsLayout(root).errors.join('\n'), /Mermaid topology differs from counterpart/u)
})

test('rejects malformed Markdown structure and broken references', async () => {
  const root = await fixture()
  writeFileSync(resolve(root, 'index.md'), '# 中文\n\n[English](./en/index.md)\n\n[missing][target]\n\n`unfinished\n')
  const errors = verifyDocsLayout(root).errors.join('\n')
  assert.match(errors, /unclosed inline code span/u)
  assert.match(errors, /unresolved Markdown reference target/u)
})

test('rejects broken local anchors', async () => {
  const root = await fixture()
  writeFileSync(resolve(root, 'index.md'), '# 中文\n\n[English](./en/index.md)\n\n[missing](#absent)\n')
  assert.match(verifyDocsLayout(root).errors.join('\n'), /broken anchor #absent/u)
})
