import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readHoloPluginConfig, validateHoloPluginOptions } from '../../tools/holonomy-plugin-config.mjs'

const runBoundedReader = (method: string, file: string) => {
  const moduleUrl = new URL('../../tools/holonomy-plugin-config.mjs', import.meta.url).href
  const script = `import { ${method} } from ${JSON.stringify(moduleUrl)};
try { ${method}(${JSON.stringify(file)}); process.exitCode = 2 }
catch (error) { process.stdout.write(error.message) }`
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 1_000
  })
}

describe('holo config bounded file ingress', () => {
  it('keeps the default config path and plugin normalization', () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-config-default-'))
    try {
      writeFileSync(join(root, 'holo.config.json'), '{"plugins":[]}')
      expect(readHoloPluginConfig(undefined, { cwd: root })).toEqual({
        configPath: join(root, 'holo.config.json'),
        plugins: []
      })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects a config symlink before reading its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-config-link-'))
    try {
      const target = join(root, 'target.json')
      const linked = join(root, 'holo.config.json')
      writeFileSync(target, '{"plugins":[]}')
      symlinkSync(target, linked)
      expect(() => readHoloPluginConfig(linked)).toThrow('must not be a symbolic link')
      expect(() => validateHoloPluginOptions(linked, {})).toThrow('must not be a symbolic link')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects a FIFO config and Schema without blocking a reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-config-fifo-'))
    try {
      const fifo = join(root, 'input.json')
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
      for (const method of ['readHoloPluginConfig', 'validateHoloPluginOptions']) {
        const result = runBoundedReader(method, fifo)
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('not a regular file')
      }
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('rejects an oversized unreadable config before opening it', () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-config-size-'))
    const file = join(root, 'holo.config.json')
    try {
      writeFileSync(file, ' '.repeat(1024 * 1024 + 1))
      chmodSync(file, 0o000)
      expect(() => readHoloPluginConfig(file)).toThrow('exceeds the size limit')
      expect(() => validateHoloPluginOptions(file, {})).toThrow('exceeds the size limit')
    } finally {
      chmodSync(file, 0o600)
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('keeps JSON syntax errors distinct from invalid UTF-8', () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-config-json-'))
    const file = join(root, 'holo.config.json')
    try {
      writeFileSync(file, '{bad')
      expect(() => readHoloPluginConfig(file)).toThrow('is not valid JSON')
      writeFileSync(file, new Uint8Array([123, 34, 255, 34, 58, 49, 125]))
      expect(() => readHoloPluginConfig(file)).toThrow('is not valid UTF-8 JSON')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
