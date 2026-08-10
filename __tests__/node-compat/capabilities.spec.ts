import { describe, expect, it } from 'vitest'

import { notSupported as rootNotSupported } from '../../src/index.js'
import { NODE_CORE_CAPABILITY_MATRIX } from '../../src/node-compat/capabilities.js'

const requiredFeatures = {
  'node:buffer': [
    'Buffer.from.string',
    'Buffer.from.ArrayBuffer',
    'Buffer.alloc',
    'Buffer.allocUnsafe',
    'Buffer.byteLength.utf8',
    'Buffer.byteLength.base64',
    'Buffer.byteLength.base64url',
    'Buffer.byteLength.hex',
    'Buffer.isBuffer',
    'Buffer.concat',
    'Buffer.subarray',
    'Buffer.slice',
    'Buffer.toString',
    'Buffer.equals',
    'encoding.utf8',
    'encoding.base64.encode',
    'encoding.base64.decode',
    'encoding.base64url.encode',
    'encoding.base64url.decode',
    'encoding.hex.encode',
    'encoding.hex.decode'
  ],
  'node:events': [
    'EventEmitter.on',
    'EventEmitter.once',
    'EventEmitter.off',
    'EventEmitter.addListener',
    'EventEmitter.removeListener',
    'EventEmitter.removeAllListeners',
    'EventEmitter.emit',
    'EventEmitter.listeners',
    'EventEmitter.listenerCount',
    'EventEmitter.setMaxListeners',
    'EventEmitter.getMaxListeners',
    'EventEmitter.errorEvent'
  ],
  'node:os': [
    'os.arch',
    'os.platform',
    'os.release',
    'os.type',
    'os.hostname',
    'os.homedir',
    'os.tmpdir',
    'os.userInfo'
  ],
  'node:path': [
    'path.basename',
    'path.dirname',
    'path.extname',
    'path.isAbsolute',
    'path.join',
    'path.parse',
    'path.relative',
    'path.resolve',
    'path.sep',
    'path.delimiter',
    'path.posix.normalize',
    'path.posix.basename',
    'path.posix.relative'
  ],
  'node:process': [
    'process.env',
    'process.cwd',
    'process.pid',
    'process.platform',
    'process.arch',
    'process.versions.node',
    'process.argv',
    'process.execPath',
    'process.on',
    'process.off',
    'process.once',
    'process.stdout.write',
    'process.stderr.write',
    'process.stdio.byteAdmissionCopy',
    'process.stdio.chunkLimit',
    'process.stdio.providerFailureMapping',
    'process.kill',
    'process.exit',
    'process.chdir'
  ],
  'node:url': ['URL', 'URLSearchParams', 'url.fileURLToPath', 'url.pathToFileURL']
} as const

describe('node core capability matrix', () => {
  it('preserves the Node Core notSupported binding at the combined package root', () => {
    expect(() => rootNotSupported('root.binding')).toThrow(
      expect.objectContaining({
        code: 'ERR_HOLONOMY_NOT_SUPPORTED',
        message: 'root.binding is not supported by the Holonomy Runtime',
        name: 'NodeCompatError'
      })
    )
  })

  it('covers every required-now feature with an explicit status', () => {
    for (const [specifier, required] of Object.entries(requiredFeatures)) {
      const capability = NODE_CORE_CAPABILITY_MATRIX.modules[
        specifier as keyof typeof NODE_CORE_CAPABILITY_MATRIX.modules
      ]
      for (const feature of required) {
        expect(capability.features[feature], `${specifier}: ${feature}`).toEqual(
          expect.objectContaining({
            status: expect.stringMatching(/^(?:supported|partial|unsupported)$/u)
          })
        )
      }
    }
  })

  it('keeps supported, partial, unsupported and feature maps consistent', () => {
    for (const capability of Object.values(NODE_CORE_CAPABILITY_MATRIX.modules)) {
      const listed = [
        ...capability.supported,
        ...capability.partial,
        ...capability.unsupported
      ]
      expect(new Set(listed).size).toBe(listed.length)
      expect(Object.keys(capability.features).sort()).toEqual([...listed].sort())
      for (const status of ['supported', 'partial', 'unsupported'] as const) {
        for (const feature of capability[status]) {
          expect(capability.features[feature]?.status).toBe(status)
        }
      }
      expect(capability.constraints.length).toBeGreaterThan(0)
      expect(Object.isFrozen(capability)).toBe(true)
      expect(Object.isFrozen(capability.features)).toBe(true)
    }
  })

  it('marks intentionally incomplete encoding and stdio surfaces partial', () => {
    const modules = NODE_CORE_CAPABILITY_MATRIX.modules
    expect(modules['node:buffer'].features['encoding.base64.malformedInput']?.status).toBe(
      'partial'
    )
    expect(modules['node:buffer'].features['encoding.hex.malformedInput']?.status).toBe(
      'partial'
    )
    expect(modules['node:process'].features['process.stdout.write']?.status).toBe(
      'partial'
    )
    expect(modules['node:process'].features['process.stdio.backpressure']?.status).toBe(
      'partial'
    )
  })

  it('machine-documents stdio resource and partial URL boundaries', () => {
    const modules = NODE_CORE_CAPABILITY_MATRIX.modules
    expect(modules['node:process'].constraints.join('\n')).toMatch(
      /frozen maxStdioChunkBytes.*1048576/u
    )
    const urlConstraints = modules['node:url'].constraints.join('\n')
    expect(urlConstraints).toMatch(/canonicalized virtual path/u)
    expect(urlConstraints).toMatch(/repeated POSIX separators do not round-trip/u)
    expect(urlConstraints).toMatch(/\[ \] \| and \^/u)
  })
})
