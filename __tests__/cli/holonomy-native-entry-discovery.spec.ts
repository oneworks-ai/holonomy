import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { expandHolonomyEntries } from '../../tools/holonomy-module-graph.mjs'

it('discovers Native CommonJS tests without walking dependency directories or source symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'holo-native-discovery-'))
  try {
    mkdirSync(join(root, 'tests'))
    mkdirSync(join(root, 'node_modules', 'deep'), { recursive: true })
    writeFileSync(join(root, 'tests', 'one.cjs'), '')
    writeFileSync(join(root, 'tests', 'two.mjs'), '')
    writeFileSync(join(root, 'node_modules', 'deep', 'not-a-project-test.mjs'), '')
    symlinkSync(join(root, 'node_modules'), join(root, 'dependency-link'))
    expect(expandHolonomyEntries([root], { native: true })).toEqual([
      join(root, 'tests', 'one.cjs'),
      join(root, 'tests', 'two.mjs')
    ])
    expect(() => expandHolonomyEntries([join(root, 'dependency-link')], { native: true })).toThrow('symbolic link')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('bounds Native matched entries before any source byte read', () => {
  const root = mkdtempSync(join(tmpdir(), 'holo-native-discovery-limit-'))
  try {
    for (let index = 0; index < 257; index++) writeFileSync(join(root, `${index}.cjs`), '')
    expect(() => expandHolonomyEntries([root], { native: true })).toThrow('file limit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
