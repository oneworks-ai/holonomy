import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

const SHIM = new URL(
  '../../../adapters/android/process-backend-v86/src/main/backend/shim.mjs',
  import.meta.url
)

describe('android v86 trusted web shim', () => {
  it('implements UTF-8 TextEncoder encodeInto without splitting a code point', async () => {
    const context = vm.createContext({ Date, Map, Uint8Array })
    vm.runInContext(await readFile(SHIM, 'utf8'), context)
    const result = JSON.parse(vm.runInContext(
      `JSON.stringify((() => {
      const encoder = new TextEncoder()
      const destination = new Uint8Array(4)
      const progress = encoder.encodeInto('Aé😀', destination)
      return {
        bytes: [...encoder.encode('Aé😀')],
        destination: [...destination],
        encoding: encoder.encoding,
        progress,
        replacement: [...encoder.encode('\\uD800')]
      }
    })())`,
      context
    ))

    expect(result).toEqual({
      bytes: [65, 195, 169, 240, 159, 152, 128],
      destination: [65, 195, 169, 0],
      encoding: 'utf-8',
      progress: { read: 2, written: 3 },
      replacement: [239, 191, 189]
    })
  })
})
