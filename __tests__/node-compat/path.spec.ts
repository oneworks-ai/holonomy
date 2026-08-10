import { posix as nodePath } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPathSyntheticModule } from '../../src/node-compat/path.js'

const cwd = '/app/project/plugins/example'
const path = createPathSyntheticModule(cwd)

describe('node:path POSIX compatibility', () => {
  it('matches Node for the promised pure POSIX operations', () => {
    const values = [
      '',
      '.',
      '..',
      '/',
      '//',
      '/app//plugin/',
      'plugin/index.mjs',
      '.env',
      '...',
      'foo.',
      'foo..',
      'a/.b',
      'archive.tar.gz',
      'a/../b/./c/',
      'a///b',
      '/..',
      '/../',
      '//..',
      '//foo',
      '///foo',
      '../../outside'
    ]
    for (const value of values) {
      expect(path.normalize(value), `normalize ${value}`).toBe(nodePath.normalize(value))
      expect(path.basename(value), `basename ${value}`).toBe(nodePath.basename(value))
      expect(path.dirname(value), `dirname ${value}`).toBe(nodePath.dirname(value))
      expect(path.extname(value), `extname ${value}`).toBe(nodePath.extname(value))
      expect(path.isAbsolute(value), `isAbsolute ${value}`).toBe(nodePath.isAbsolute(value))
      expect(path.parse(value), `parse ${value}`).toEqual(nodePath.parse(value))
    }
  })

  it('matches Node joins, cwd-bound resolves and relatives', () => {
    const joins = [
      ['', ''],
      ['/app', 'plugins', '../cache'],
      ['a/', '/b', 'c'],
      ['..', 'a', '..']
    ]
    for (const parts of joins) {
      expect(path.join(...parts)).toBe(nodePath.join(...parts))
    }

    const resolves = [
      [],
      ['plugin.mjs'],
      ['../shared', './index.js'],
      ['/app/root', '../child'],
      ['', 'a']
    ]
    for (const parts of resolves) {
      expect(path.resolve(...parts)).toBe(nodePath.resolve(cwd, ...parts))
    }

    const relatives = [
      ['.', '.'],
      ['.', '../shared'],
      ['/app/a/b', '/app/a/c'],
      ['one', '/app/other']
    ]
    for (const [from, to] of relatives) {
      expect(path.relative(from!, to!)).toBe(
        nodePath.relative(nodePath.resolve(cwd, from), nodePath.resolve(cwd, to))
      )
    }
  })

  it('exposes the promised POSIX constants and namespace functions', () => {
    expect(path.sep).toBe('/')
    expect(path.delimiter).toBe(':')
    expect(path.posix.normalize('a//b')).toBe('a/b')
    expect(path.posix.basename('/a/b.txt', '.txt')).toBe('b')
    expect(path.posix.relative('/app/a', '/app/b')).toBe('../b')
    expect(path.default.posix.normalize('a//b')).toBe('a/b')
    expect(path.resolve('../../../../outside')).toBe('/outside')
    expect(Object.isFrozen(path)).toBe(true)
    expect(Object.isFrozen(path.posix)).toBe(true)
  })

  it('matches Node basename suffix edge cases', () => {
    const cases = [
      ['/', '.'],
      ['/', '/'],
      ['//', '.'],
      ['foo', 'foo'],
      ['foo', 'oo'],
      ['foo/', 'oo'],
      ['/foo/', 'bar'],
      ['/foo/', '/'],
      ['/app/file.txt', '.txt']
    ] as const
    for (const [value, suffix] of cases) {
      expect(path.basename(value, suffix)).toBe(nodePath.basename(value, suffix))
    }
  })
})
