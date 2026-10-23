import { describe, expect, it } from 'vitest'

import {
  createCommonJsModuleStateV1,
  createCommonJsRequireV1
} from '../../../packages/runtime/src/module-loader/commonjs-runtime.js'

describe('shared CommonJS runtime shape', () => {
  it('keeps virtual identities and main reference without introducing a second resolver', () => {
    const main = createCommonJsModuleStateV1('app://workspace/index.js', true, {})
    const calls: string[] = []
    const require = createCommonJsRequireV1(
      specifier => {
        calls.push(specifier)
        return main.exports
      },
      specifier => `admitted:${specifier}`,
      main
    )
    expect(main).toMatchObject({
      id: '.',
      filename: 'app://workspace/index.js',
      path: 'app://workspace',
      loaded: false
    })
    expect(require.main).toBe(main)
    expect(require.resolve('./child.cjs')).toBe('admitted:./child.cjs')
    expect(calls).toEqual([])
    expect(require('./child.cjs')).toBe(main.exports)
    expect(calls).toEqual(['./child.cjs'])
  })

  it('rejects non-string or non-scalar ids without calling Guest conversion or the engine port', () => {
    let entered = 0
    const port = () => {
      entered++
      return 'unexpected'
    }
    const require = createCommonJsRequireV1(port, port, undefined)
    const object = {
      toString() {
        entered++
        return 'node:path'
      }
    }
    for (const invalid of [object, 1, null, undefined]) {
      expect(() => require(invalid)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
      expect(() => require.resolve(invalid)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
    }
    for (const invalid of ['\uD800', '\uDC00', 'a\uD800b']) {
      expect(() => require(invalid)).toThrow(expect.objectContaining({ code: 'ERR_HOLONOMY_MODULE_INVALID_URL' }))
    }
    expect(entered).toBe(0)
    expect(require.main).toBeUndefined()
  })
})
