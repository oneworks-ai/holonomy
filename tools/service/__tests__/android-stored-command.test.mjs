import assert from 'node:assert/strict'
import { afterEach, describe, it, vi } from 'vitest'

import { submitStoredAndroidCommand } from '../android-stored-command.mjs'

const options = (controller, execute) => ({
  adb: 'adb',
  command: { command: 'status' },
  commandId: 'command-1',
  execute,
  serial: 'emulator-5554',
  signal: controller.signal,
  timeoutMs: 10_000
})

const isPoll = args => args.includes('cat')
const isCleanup = args => args.includes('rm')

afterEach(() => vi.useRealTimers())

describe('stored Android command aborts', () => {
  it('interrupts an in-flight reply read and runs cleanup without the aborted signal', async () => {
    const controller = new AbortController()
    const abort = new Error('cancelled by test')
    let cleanupOptions
    let polls = 0
    let resolvePoll
    const execute = async (_file, args, executeOptions) => {
      if (isCleanup(args)) cleanupOptions = executeOptions
      if (!isPoll(args)) return ''
      polls += 1
      return await new Promise(resolve => resolvePoll = resolve)
    }
    const pending = submitStoredAndroidCommand(options(controller, execute))
    for (let turn = 0; turn < 20; turn += 1) {
      if (polls > 0) break
      await Promise.resolve()
    }
    assert.equal(polls, 1)

    controller.abort(abort)
    await assert.rejects(pending, error => error === abort)
    assert.equal(polls, 1)
    assert.equal(cleanupOptions.signal, undefined)
    resolvePoll('')
    await Promise.resolve()
    assert.equal(polls, 1)
  })

  it('cancels the 100ms pause without scheduling another poll', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const abort = new Error('cancelled during pause')
    let cleanups = 0
    let polls = 0
    const execute = async (_file, args, executeOptions) => {
      if (isCleanup(args)) {
        cleanups += 1
        assert.equal(executeOptions.signal, undefined)
      }
      if (isPoll(args)) polls += 1
      return ''
    }
    const pending = submitStoredAndroidCommand(options(controller, execute))
    for (let turn = 0; turn < 20 && vi.getTimerCount() === 0; turn += 1) await Promise.resolve()
    assert.equal(polls, 1)
    assert.equal(vi.getTimerCount(), 1)

    controller.abort(abort)
    await assert.rejects(pending, error => error === abort)
    assert.equal(cleanups, 1)
    assert.equal(vi.getTimerCount(), 0)
    await vi.advanceTimersByTimeAsync(500)
    assert.equal(polls, 1)
  })
})
