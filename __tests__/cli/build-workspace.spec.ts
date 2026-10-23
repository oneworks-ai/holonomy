import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

const builder = new URL('../../tools/build-workspace.mjs', import.meta.url)

const withFixture = (work: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), 'holo-build-workspace-'))
  try {
    mkdirSync(join(root, 'tools'))
    copyFileSync(builder, join(root, 'tools/build-workspace.mjs'))
    mkdirSync(join(root, 'packages/runtime/src/kernel/machine'), { recursive: true })
    writeFileSync(join(root, 'packages/runtime/src/kernel/machine/example.json'), '{"schemaVersion":1}\n')
    work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const run = (root: string) =>
  spawnSync(process.execPath, [join(root, 'tools/build-workspace.mjs')], {
    cwd: root,
    env: { PATH: '' },
    encoding: 'utf8',
    timeout: 10_000
  })

const installCompiler = (root: string, code: number) => {
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true })
  writeFileSync(join(root, 'node_modules/typescript/package.json'), '{"name":"typescript","version":"0.0.0-test"}')
  writeFileSync(
    join(root, 'node_modules/typescript/bin/tsc'),
    `
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== '-p tsconfig.build.json') process.exit(99);
fs.mkdirSync('.build/src', {recursive:true});
fs.mkdirSync('.build/packages/runtime/src', {recursive:true});
fs.writeFileSync('.build/src/index.js', 'compat-output');
fs.writeFileSync('.build/packages/runtime/src/index.js', 'runtime-output');
process.exit(${code});
`
  )
}

describe('workspace build uses its installed compiler without package-manager side effects', () => {
  it('builds and copies the usual outputs with no executable on PATH', () =>
    withFixture(root => {
      installCompiler(root, 0)
      const result = run(root)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(root, 'dist/index.js'), 'utf8')).toBe('compat-output')
      expect(readFileSync(join(root, 'packages/runtime/dist/index.js'), 'utf8')).toBe('runtime-output')
      for (const path of ['dist/capability-runtime/machine', 'packages/runtime/dist/kernel/machine']) {
        expect(JSON.parse(readFileSync(join(root, path, 'example.json'), 'utf8'))).toEqual({ schemaVersion: 1 })
      }
      expect(existsSync(join(root, '.build'))).toBe(false)
    }))

  it('returns a compiler failure without deleting the previous distribution', () =>
    withFixture(root => {
      installCompiler(root, 7)
      mkdirSync(join(root, 'dist'))
      writeFileSync(join(root, 'dist/last-good.txt'), 'last-good')
      const result = run(root)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(7)
      expect(readFileSync(join(root, 'dist/last-good.txt'), 'utf8')).toBe('last-good')
    }))

  it('fails without an installed compiler and preserves existing output', () =>
    withFixture(root => {
      mkdirSync(join(root, 'dist'))
      writeFileSync(join(root, 'dist/last-good.txt'), 'last-good')
      const result = run(root)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('TypeScript is not installed')
      expect(readFileSync(join(root, 'dist/last-good.txt'), 'utf8')).toBe('last-good')
      expect(existsSync(join(root, 'node_modules'))).toBe(false)
    }))
})
