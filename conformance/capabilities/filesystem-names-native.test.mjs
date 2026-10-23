import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { test } from 'node:test'

const names = ['a b.txt', '中文😀.txt', '%literal.txt', '%2F.txt', '.hidden']
const path = name => `holo-fs://workspace/${encodeURIComponent(name)}`

export const registerFilesystemNameTests = ({ withinRoot }) => {
  for (const name of names) {
    test(`reads the Host filename without changing its spelling: ${name}`, () => {
      assert.equal(fs.readFileSync(path(name), 'utf8'), `HOST:${name}`)
    })
  }

  test('directory entries retain native names, not URI-encoded tokens', () => {
    const entries = fs.readdirSync('holo-fs://workspace/')
    for (const name of names) assert(entries.includes(name), name)
  })

  test('promise write/read keeps a literal percent sequence in the filename', async () => {
    await fsp.writeFile(path('new 中 %2F.txt'), 'GUEST_WRITE')
    assert.equal(await fsp.readFile(path('new 中 %2F.txt'), 'utf8'), 'GUEST_WRITE')
  })

  test('FileHandle opens the same Host name as path reads', async () => {
    const file = await fsp.open(path('%2F.txt'), 'r')
    try {
      assert.equal(await file.readFile('utf8'), 'HOST:%2F.txt')
    } finally {
      await file.close()
    }
  })

  test('unsafe encoded segments fail without traversing the Host namespace', () => {
    for (const name of ['bad%2Fslash', 'bad%5Cbackslash', 'bad%00nul', '%2E%2E', '%FF', '%']) {
      assert.throws(() => fs.statSync(`holo-fs://workspace/${name}`))
    }
  })

  if (withinRoot) {
    test('resolution keeps a raw symlink target containing literal %2F', () => {
      assert.equal(fs.readFileSync(path('link 中.txt'), 'utf8'), 'HOST:%2F.txt')
    })
  } else {
    test('rename decodes the requested and destination names exactly once', () => {
      fs.renameSync(path('rename %2F.txt'), path('moved 中😀.txt'))
      assert.equal(fs.readFileSync(path('moved 中😀.txt'), 'utf8'), 'HOST:rename %2F.txt')
    })
  }
}
