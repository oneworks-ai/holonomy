import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'vitest'

import { executeAndroidCommand } from '../android-command-executor.mjs'

class IgnoringChild extends EventEmitter {
  exitCode = null
  signalCode = null
  stderr = new EventEmitter()
  stdin = { end() {} }
  stdout = new EventEmitter()
  signals = []

  kill(signal) {
    this.signals.push(signal)
    if (signal === 'SIGKILL') {
      this.signalCode = signal
      this.emit('exit', null, signal)
    }
    return true
  }
}

describe('android command execution', () => {
  it('settles cancellation immediately and force-terminates a child that ignores SIGTERM', async () => {
    const child = new IgnoringChild()
    const controller = new AbortController()
    const pending = executeAndroidCommand('adb', ['devices'], {
      signal: controller.signal,
      spawn: () => child,
      terminationGraceMs: 1
    })

    controller.abort()
    await assert.rejects(pending, error => error.message === 'Android command was cancelled')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  })
})
