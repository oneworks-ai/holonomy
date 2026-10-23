import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createNativeSourceReader } from '../../tools/holonomy-native-source-reader.mjs'

const makeHelper = (root: string, mode: string) => {
  const binaryPath = join(root, `source-helper-${mode}`)
  writeFileSync(
    binaryPath,
    `#!${process.execPath}
import { createHash } from 'node:crypto'
const mode = ${JSON.stringify(mode)}
let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  pending += chunk
  for (;;) {
    const end = pending.indexOf('\\n')
    if (end < 0) break
    const request = JSON.parse(pending.slice(0, end))
    pending = pending.slice(end + 1)
    if (mode === 'stall' && request.op === 'statPrivate') continue
    const bytes = mode === 'large-manifest' ? Buffer.alloc(1024 * 1024 + 1, 97) : Buffer.from('abc')
    let value = null
    if (request.op === 'init') value = { rootUrl: 'app://workspace/' }
    if (request.op === 'statPrivate' || request.op === 'capturePrivate') {
      value = { kind: 'file', size: 3, mtimeMs: 1 }
    }
    if (request.op === 'seal' || request.op === 'close') value = true
    if (request.op === 'readPrivate' || request.op === 'readGuest') {
      value = {
        base64: bytes.toString('base64'),
        sha256: mode === 'bad-sha' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex')
      }
    }
    if (request.op === 'openPrivatePackage') {
      const manifest = mode === 'large-package-manifest'
        ? Buffer.alloc(1024 * 1024 + 1, 97)
        : Buffer.from('abc')
      value = {
        packageId: mode === 'bad-package-id' ? '' : mode === 'non-ascii-package-id' ? 'é' : 'lease-1',
        rootPath: mode === 'bad-package-root' ? '/outside-root' : request.root + '/node_modules/pkg',
        base64: manifest.toString('base64'),
        sha256: mode === 'bad-package-sha'
          ? '0'.repeat(64)
          : createHash('sha256').update(manifest).digest('hex'),
        ...(mode === 'bad-package-shape' ? { extra: true } : {})
      }
    }
    if (request.op === 'readPrivatePackage') {
      value = {
        base64: bytes.toString('base64'),
        sha256: mode === 'bad-package-read-sha'
          ? '0'.repeat(64)
          : createHash('sha256').update(bytes).digest('hex')
      }
    }
    const id = mode === 'bad-id' && request.op === 'statPrivate' ? request.id + 1 : request.id
    const response = mode === 'bad-code' && request.op === 'statPrivate'
      ? { schemaVersion: 1, id, ok: false, code: 'unexpected_code' }
      : { schemaVersion: 1, id, ok: true, value }
    process.stdout.write(JSON.stringify(response) + '\\n', () => {
      if (request.op === 'close') process.exit(0)
    })
  }
})
`
  )
  chmodSync(binaryPath, 0o700)
  return binaryPath
}

describe('native source reader JSONL client', () => {
  it('keeps one owned child through private, sealed Guest, and close phases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, 'normal'),
        workspaceRoot: root
      })
      try {
        expect(await reader.statPrivate(join(root, 'index.mjs'))).toEqual({
          kind: 'file',
          size: 3,
          mtimeMs: 1
        })
        expect(await reader.capturePrivate(join(root, 'index.mjs'))).toEqual({
          kind: 'file',
          size: 3,
          mtimeMs: 1
        })
        expect((await reader.readPrivate(join(root, 'index.mjs'), 'module'))?.bytes.toString())
          .toBe('abc')
        await reader.seal()
        expect((await reader.readGuest('app://workspace/index.mjs'))?.bytes.toString())
          .toBe('abc')
        // Watch preparation uses the same retained reader after seal.
        expect((await reader.readPrivate(join(root, 'index.mjs'), 'module'))?.bytes.toString())
          .toBe('abc')
      } finally {
        await reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['bad-id', 'bad-sha', 'bad-code'])('fails closed on %s protocol corruption', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-bad-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, mode),
        workspaceRoot: root
      })
      try {
        const operation = mode === 'bad-id' || mode === 'bad-code'
          ? reader.statPrivate(join(root, 'index.mjs'))
          : reader.readPrivate(join(root, 'index.mjs'), 'module')
        await expect(operation).rejects.toMatchObject({ code: 'invalid_response' })
      } finally {
        await reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cancels an in-flight read and reaps its child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-abort-'))
    try {
      const controller = new AbortController()
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, 'stall'),
        workspaceRoot: root,
        signal: controller.signal
      })
      const operation = reader.statPrivate(join(root, 'index.mjs'))
      controller.abort()
      await expect(operation).rejects.toMatchObject({ code: 'cancelled' })
      await reader.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a manifest over the config and Schema byte limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-manifest-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, 'large-manifest'),
        workspaceRoot: root
      })
      try {
        const selected = await reader.readPrivate(join(root, 'package.json'), 'manifest')
        expect(selected?.bytes.byteLength).toBe(1024 * 1024 + 1)
      } finally {
        await reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pins a package lease and reads only validated relative module and Schema paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-package-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, 'normal'),
        workspaceRoot: root
      })
      try {
        const manifest = join(root, 'node_modules', 'pkg', 'package.json')
        const opened = await reader.openPrivatePackage(root, manifest)
        expect(opened).toEqual({
          packageId: 'lease-1',
          rootPath: join(root, 'node_modules', 'pkg'),
          bytes: Buffer.from('abc'),
          sha256: createHash('sha256').update('abc').digest('hex')
        })
        expect((await reader.readPrivatePackage('lease-1', 'dist/index.mjs', 'module'))?.bytes.toString())
          .toBe('abc')
        await reader.seal()
        expect((await reader.readPrivatePackage('lease-1', 'schema.json', 'schema'))?.bytes.toString())
          .toBe('abc')
        for (const relativePath of ['../escape.mjs', '/absolute.mjs', 'a//b.mjs', 'a/./b.mjs', 'a\\b.mjs']) {
          await expect(reader.readPrivatePackage('lease-1', relativePath, 'module'))
            .rejects.toMatchObject({ code: 'invalid_request' })
        }
        await expect(reader.readPrivatePackage('unknown', 'index.mjs', 'module'))
          .rejects.toMatchObject({ code: 'invalid_request' })
        await expect(reader.openPrivatePackage(root, join(root, '..', 'outside', 'package.json')))
          .rejects.toMatchObject({ code: 'invalid_request' })
        expect((await reader.readPrivatePackage('lease-1', 'index.mjs', 'module'))?.bytes.toString())
          .toBe('abc')
      } finally {
        await reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'bad-package-id',
    'non-ascii-package-id',
    'bad-package-root',
    'bad-package-sha',
    'bad-package-shape',
    'large-package-manifest'
  ])('fails closed on %s package open response', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-package-bad-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, mode),
        workspaceRoot: root
      })
      try {
        await expect(reader.openPrivatePackage(root, join(root, 'node_modules', 'pkg', 'package.json')))
          .rejects.toMatchObject({ code: 'invalid_response' })
      } finally {
        await reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed on a corrupt package module digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-package-read-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, 'bad-package-read-sha'),
        workspaceRoot: root
      })
      try {
        await reader.openPrivatePackage(root, join(root, 'node_modules', 'pkg', 'package.json'))
        await expect(reader.readPrivatePackage('lease-1', 'index.mjs', 'module'))
          .rejects.toMatchObject({ code: 'invalid_response' })
      } finally {
        await reader.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('closes promptly with active and queued reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'holo-source-reader-close-'))
    try {
      const reader = await createNativeSourceReader({
        binaryPath: makeHelper(root, 'stall'),
        workspaceRoot: root,
        timeoutMs: 5_000
      })
      const outcomes = Promise.allSettled([
        reader.statPrivate(join(root, 'index.mjs')),
        reader.readPrivate(join(root, 'package.json'), 'manifest')
      ])
      await reader.close()
      const selected = await outcomes
      expect(selected.map(item => item.status)).toEqual(['rejected', 'rejected'])
      expect(selected.every(item => item.status === 'rejected' && item.reason.code === 'closed')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
