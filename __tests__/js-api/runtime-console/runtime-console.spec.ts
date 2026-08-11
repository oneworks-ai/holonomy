import { describe, expect, it } from 'vitest'

import { createRuntimeConsole } from '../../../src/runtime-console/index.js'

describe('runtime console', () => {
  it('formats console values in JavaScript and sends one host event', () => {
    const events: Array<{ level: string; message: string }> = []
    const runtimeConsole = createRuntimeConsole({
      write(level, message) {
        events.push({ level, message })
      }
    })
    let guestInspectionCalls = 0
    const object = Object.defineProperty({ answer: 42 }, 'toJSON', {
      get() {
        guestInspectionCalls += 1
        return () => ({ answer: 42 })
      }
    })
    runtimeConsole.global.log('value', object)
    expect(events).toEqual([{ level: 'log', message: 'value [Object]' }])
    expect(guestInspectionCalls).toBe(0)
    runtimeConsole.global.log('x'.repeat(70 * 1024))
    expect(events[1]?.message.length).toBe(64 * 1024)
    expect(events[1]?.message.endsWith('…')).toBe(true)
    expect(runtimeConsole.syntheticModule.default).toBe(runtimeConsole.global)
  })
})
